#!/usr/bin/env tsx
/**
 * One-shot: record which lead types each of Amy Laidlaw's teammates handles,
 * as a fact about the person rather than a name typed into one flow.
 *
 * Amy, 2026-08-12: "it is Dave and Gabby for Seller leads and Dave, Gabby, and
 * Jason for Buyer leads."
 *
 * That rule was true in exactly ONE place before this: the two arms of
 * "Follow Up Requested (Unclaimed Leads)". Twelve other route steps knew
 * nothing about it, and Jason appeared nowhere else on the account. Written on
 * the roster instead, adding a teammate or moving who covers what is one edit.
 *
 * AMY IS DELIBERATELY UNTAGGED. Her row already carries
 * team_broadcast_enabled=false, which is what keeps her out of team alerts;
 * tagging her would have no effect on that and would suggest she is part of an
 * audience she is deliberately not part of. She remains in the CLAIM OFFERS
 * exactly as the Aug 8 speed-to-lead patch set them, which this does not touch.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-roster-lead-type-tags.ts          # dry run
 *   npx tsx scripts/oneshot/amy-roster-lead-type-tags.ts --apply
 *
 * Exit codes: 0 tagged/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/**
 * Who handles what. "both" is listed explicitly rather than inferred: a lead
 * doing both is a seller conversation first on this account, and Amy's rule
 * puts sellers with Dave and Gabby.
 */
export const LEAD_TYPE_TAGS: Record<string, string[]> = {
  "Dave Lane": ["buyer", "seller", "both"],
  "Gabrielle Mota": ["buyer", "seller", "both"],
  "Jason Lane": ["buyer"]
};

/** Merge without disturbing tags somebody set for another purpose. */
export function mergeTags(existing: readonly string[], add: readonly string[]): string[] {
  const out = [...existing];
  const seen = new Set(out.map((t) => t.trim().toLowerCase()));
  for (const t of add) {
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--business-id");
  const businessId = i >= 0 ? (process.argv[i + 1] ?? DEFAULT_BUSINESS_ID) : DEFAULT_BUSINESS_ID;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("id,name,tags,active,team_broadcast_enabled")
    .eq("business_id", businessId);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    tags: string[] | null;
    active: boolean;
    team_broadcast_enabled: boolean | null;
  }>;
  const missing = Object.keys(LEAD_TYPE_TAGS).filter((n) => !rows.some((r) => r.name === n));
  if (missing.length > 0) {
    console.error(`Roster members not found on ${businessId}: ${missing.join(", ")}`);
    process.exit(2);
  }

  const changed: Array<{ id: string; name: string; tags: string[] }> = [];
  for (const row of rows) {
    const want = LEAD_TYPE_TAGS[row.name];
    if (!want) {
      console.log(
        `${row.name}: left untagged` +
          (row.team_broadcast_enabled === false ? " (team broadcasts already off)" : "")
      );
      continue;
    }
    const next = mergeTags(row.tags ?? [], want);
    if (next.length === (row.tags ?? []).length) {
      console.log(`${row.name}: already ${JSON.stringify(next)}`);
      continue;
    }
    console.log(`${row.name}: ${JSON.stringify(row.tags ?? [])} -> ${JSON.stringify(next)}`);
    changed.push({ id: row.id, name: row.name, tags: next });
  }
  if (changed.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }
  for (const c of changed) {
    const { error: upErr } = await db
      .from("ai_flow_team_members")
      .update({ tags: c.tags })
      .eq("id", c.id);
    if (upErr) {
      console.error(`Update failed for ${c.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  -> tagged ${c.name}.`);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-roster-lead-type-tags.ts",
    businessId,
    details: { tagged: changed.map((c) => ({ name: c.name, tags: c.tags })) }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
