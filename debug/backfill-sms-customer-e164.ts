#!/usr/bin/env tsx
/**
 * One-off: backfill `sms_inbound_jobs.customer_e164` from the Telnyx envelope
 * sender for rows where the column is NULL.
 *
 * Why: the contact detail page + cross-channel summarizer query SMS by the
 * `customer_e164` COLUMN, but AiFlow-suppressed (and legacy Safe Mode) inbound
 * jobs were persisted without it — only the JSONB `payload` carried the sender.
 * So a contact's texts showed in the raw thread view (which parses payload) but
 * NOT on the contact page, and never counted as interactions. The writer paths
 * (telnyx-sms-inbound + sms-inbound-worker) now stamp the column going forward;
 * this fills the historical gap. Idempotent: only touches NULL rows, and copies
 * the same value the thread view already derives.
 *
 * Usage: `tsx debug/backfill-sms-customer-e164.ts` (dry run) then `--apply`.
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { customerE164FromPayload } from "../src/lib/db/sms-history.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);
const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("id, payload")
    .is("customer_e164", null);
  if (error) throw new Error(`select null rows: ${error.message}`);
  const rows = (data as Array<{ id: string; payload: Record<string, unknown> }> | null) ?? [];

  let fixable = 0;
  let skipped = 0;
  let updated = 0;
  for (const row of rows) {
    const sender = customerE164FromPayload(row.payload);
    if (!sender) {
      skipped += 1;
      continue;
    }
    fixable += 1;
    if (!APPLY) continue;
    const { error: upErr } = await db
      .from("sms_inbound_jobs")
      .update({ customer_e164: sender })
      .eq("id", row.id)
      .is("customer_e164", null);
    if (upErr) {
      console.error(`update ${row.id}: ${upErr.message}`);
      continue;
    }
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        null_rows: rows.length,
        backfillable: fixable,
        unparseable_skipped: skipped,
        updated
      },
      null,
      2
    )
  );
  if (!APPLY && fixable > 0) {
    console.log("\nRe-run with --apply to write.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
