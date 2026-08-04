/**
 * Fleet audit: tools an owner turned OFF on one channel that are still ON
 * elsewhere.
 *
 * `agent_tool_settings` is keyed per `agent_key`, and a MISSING row means
 * "registry default", not "off". So a channel policy reaches only the channel
 * it was set on, and nothing in the product flags the gap.
 *
 * Amy Laidlaw Real Estate is why this exists. Her five calendar tools were
 * disabled for `sms` on Jul 29 2026; `voice` never got the same rows, kept the
 * registry default (enabled), and her phone coworker went on booking
 * appointments for five more days until a customer call surfaced it. This
 * turns "we would have caught that in a minute" into a command.
 *
 * Read-only. Exits 1 when anything diverges, so it can gate a check.
 *
 * Usage:
 *   npx tsx debug/audit-agent-tool-channels.ts
 *   npx tsx debug/audit-agent-tool-channels.ts --business-id <uuid>
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { findChannelDivergences, describeDivergence } = await import(
  "../src/lib/agent-tools/channel-divergence.ts"
);

const bizFlag = process.argv.indexOf("--business-id");
const ONLY_BUSINESS = bizFlag >= 0 ? process.argv[bizFlag + 1] : null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

let bizQuery = db.from("businesses").select("id, name").order("name");
if (ONLY_BUSINESS) bizQuery = bizQuery.eq("id", ONLY_BUSINESS);
const { data: businesses, error: bizErr } = await bizQuery;
if (bizErr) {
  console.error(`Read businesses: ${bizErr.message}`);
  process.exit(1);
}

let settingsQuery = db
  .from("agent_tool_settings")
  .select("business_id, agent_key, tool_key, enabled");
if (ONLY_BUSINESS) settingsQuery = settingsQuery.eq("business_id", ONLY_BUSINESS);
const { data: settings, error: settingsErr } = await settingsQuery;
if (settingsErr) {
  console.error(`Read agent_tool_settings: ${settingsErr.message}`);
  process.exit(1);
}

const byBusiness = new Map<
  string,
  Array<{ agent_key: string; tool_key: string; enabled: boolean }>
>();
for (const row of settings ?? []) {
  const r = row as {
    business_id: string;
    agent_key: string;
    tool_key: string;
    enabled: boolean;
  };
  const list = byBusiness.get(r.business_id) ?? [];
  list.push({ agent_key: r.agent_key, tool_key: r.tool_key, enabled: r.enabled });
  byBusiness.set(r.business_id, list);
}

let flagged = 0;
for (const biz of (businesses ?? []) as Array<{ id: string; name: string }>) {
  const overrides = byBusiness.get(biz.id) ?? [];
  const divergences = findChannelDivergences(overrides);
  if (divergences.length === 0) continue;
  flagged += 1;
  console.log(`\n${biz.name}  (${biz.id})`);
  for (const d of divergences) console.log(`  ${describeDivergence(d)}`);
}

const scanned = (businesses ?? []).length;
if (flagged === 0) {
  console.log(`\nNo channel divergence across ${scanned} business(es).`);
  process.exit(0);
}
console.log(
  `\n${flagged} of ${scanned} business(es) have a tool turned off on one ` +
    `channel and still on for another.\n` +
    `A missing agent_tool_settings row means the REGISTRY DEFAULT, not off, ` +
    `so the fix is usually to write the same disabled rows for the other channel.`
);
process.exit(1);
