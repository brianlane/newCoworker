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

/**
 * Page through a table in 1000-row chunks.
 *
 * PostgREST silently caps a single response at 1000 rows. For an audit that is
 * the worst possible failure: dropped `agent_tool_settings` rows mean missing
 * explicit OFFs, which means `findChannelDivergences` reports a clean fleet
 * while the gap is still there. Same discipline as
 * `loadBillableUsageSince` in src/lib/billing/usage-charges.ts, and reads
 * THROW rather than degrade, so a partial answer never prints as a clean one.
 */
const PAGE_SIZE = 1000;
async function readAll<Row>(
  table: string,
  columns: string,
  orderColumn: string
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = db
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (ONLY_BUSINESS) {
      q = q.eq(table === "businesses" ? "id" : "business_id", ONLY_BUSINESS);
    }
    const { data, error } = await q;
    if (error) throw new Error(`Read ${table}: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

let businesses: Array<{ id: string; name: string }>;
let settings: Array<{
  business_id: string;
  agent_key: string;
  tool_key: string;
  enabled: boolean;
}>;
try {
  businesses = await readAll("businesses", "id, name", "name");
  settings = await readAll(
    "agent_tool_settings",
    "business_id, agent_key, tool_key, enabled",
    "business_id"
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const byBusiness = new Map<
  string,
  Array<{ agent_key: string; tool_key: string; enabled: boolean }>
>();
for (const r of settings) {
  const list = byBusiness.get(r.business_id) ?? [];
  list.push({ agent_key: r.agent_key, tool_key: r.tool_key, enabled: r.enabled });
  byBusiness.set(r.business_id, list);
}

let flagged = 0;
for (const biz of businesses) {
  const overrides = byBusiness.get(biz.id) ?? [];
  const divergences = findChannelDivergences(overrides);
  if (divergences.length === 0) continue;
  flagged += 1;
  console.log(`\n${biz.name}  (${biz.id})`);
  for (const d of divergences) console.log(`  ${describeDivergence(d)}`);
}

const scanned = businesses.length;
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
