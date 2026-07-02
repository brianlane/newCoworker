#!/usr/bin/env tsx
/**
 * Requeue dead-lettered `sms_inbound_jobs` so the sms-inbound-worker retries
 * them (fresh `attempt_count`), e.g. after fixing the root cause of an outage.
 *
 * Motivating incident: after the June 19 per-tenant gateway-token re-key, the
 * worker kept presenting the stale shared `ROWBOAT_GATEWAY_TOKEN` to Amy's
 * Rowboat, so every customer text 500'd through 8 attempts and dead-lettered.
 * Once the worker resolves per-tenant tokens (PR "per-tenant Rowboat bearer"),
 * this script puts the stranded messages back through the pipeline.
 *
 * Dry run lists the dead letters (age, attempts, sender, text preview,
 * last_error). `--apply` resets them to `pending` with attempt_count=0 (the
 * cron drains within a minute). The customer receives the reply late — only
 * requeue conversations where a late reply is better than silence.
 *
 * Usage:
 *   tsx debug/requeue-sms-deadletters.ts [--business <id>] [--since 2026-06-19] [--error <substr>]
 *   tsx debug/requeue-sms-deadletters.ts --business <id> --apply
 */
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key);

const APPLY = process.argv.includes("--apply");
const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
};
const BUSINESS_ID = argValue("--business");
const SINCE = argValue("--since"); // ISO date; default = all
const ERROR_SUBSTR = argValue("--error"); // filter by last_error content

type Row = {
  id: string;
  business_id: string;
  customer_e164: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  payload: Record<string, unknown>;
};

/** Sender + text from the Telnyx envelope (mirrors the worker's parse). */
function preview(payload: Record<string, unknown>): { from: string; text: string } {
  const p = (payload as { data?: { payload?: Record<string, unknown> } })?.data?.payload ?? {};
  const from =
    typeof p.from === "object" && p.from !== null
      ? String((p.from as { phone_number?: unknown }).phone_number ?? "")
      : String(p.from ?? "");
  const text = String((p as { text?: unknown }).text ?? "");
  return { from, text };
}

async function main(): Promise<void> {
  let q = db
    .from("sms_inbound_jobs")
    .select("id, business_id, customer_e164, attempt_count, last_error, created_at, updated_at, payload")
    .eq("status", "dead_letter")
    .order("created_at", { ascending: true });
  if (BUSINESS_ID) q = q.eq("business_id", BUSINESS_ID);
  if (SINCE) q = q.gte("created_at", SINCE);
  const { data, error } = await q;
  if (error) throw new Error(`select dead letters: ${error.message}`);
  let rows = ((data as Row[] | null) ?? []).filter(
    (r) => !ERROR_SUBSTR || (r.last_error ?? "").includes(ERROR_SUBSTR)
  );

  // Rows the worker itself dead-letters for permanently-invalid input would
  // just dead-letter again — leave them unless explicitly targeted via --error.
  const PERMANENT = new Set(["missing_from_or_text", "missing_rowboat_project_or_bearer"]);
  const skippedPermanent = ERROR_SUBSTR
    ? []
    : rows.filter((r) => PERMANENT.has(r.last_error ?? ""));
  if (!ERROR_SUBSTR) rows = rows.filter((r) => !PERMANENT.has(r.last_error ?? ""));

  for (const r of rows) {
    const { from, text } = preview(r.payload);
    const age = Math.round((Date.now() - Date.parse(r.created_at)) / 3_600_000);
    console.log(
      `${r.id}  biz=${r.business_id}  from=${r.customer_e164 ?? from}  age=${age}h  attempts=${r.attempt_count}` +
        `\n    error: ${(r.last_error ?? "").slice(0, 140)}` +
        `\n    text:  ${text.slice(0, 120)}`
    );
  }
  if (skippedPermanent.length > 0) {
    console.log(
      `\n(skipped ${skippedPermanent.length} permanently-invalid rows — target explicitly with --error if intended)`
    );
  }

  if (!APPLY) {
    console.log(
      `\n[dry-run] ${rows.length} dead-lettered job(s) would be reset to pending. --apply to requeue.`
    );
    return;
  }

  let requeued = 0;
  for (const r of rows) {
    // attempt_count restarts so the job gets a full retry budget; guard on
    // status so a concurrently-drained row is never double-reset.
    const { error: upErr } = await db
      .from("sms_inbound_jobs")
      .update({ status: "pending", attempt_count: 0, last_error: null, updated_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("status", "dead_letter");
    if (upErr) {
      console.error(`requeue ${r.id}: ${upErr.message}`);
      continue;
    }
    requeued += 1;
  }
  console.log(`\nrequeued ${requeued}/${rows.length} job(s) — the worker cron drains within ~1 min.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
