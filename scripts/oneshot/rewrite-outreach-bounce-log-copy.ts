/**
 * rewrite-outreach-bounce-log-copy.ts: restamp email_delivery_failed rows
 * whose bounce already retired an outreach pitch, so the admin System Errors
 * card does not quote Resend's "remove them from your mailing list" advice
 * as if a human still has to do that.
 *
 * The live webhook now writes the honest sentence via
 * formatEmailDeliveryFailedLogMessage. Rows logged before that still carry
 * the vendor paragraph. This script finds those rows by joining payload.to
 * to outreach_prospects that are already failed with a pitch-bounce detail,
 * and rewrites only the message (payload.errorMessage is left as the vendor
 * text).
 *
 * Idempotent: a row whose message already contains "Outreach follow-up
 * cancelled" is skipped.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/rewrite-outreach-bounce-log-copy.ts
 *   npx tsx scripts/oneshot/rewrite-outreach-bounce-log-copy.ts --since 14d
 *   npx tsx scripts/oneshot/rewrite-outreach-bounce-log-copy.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger";
import { formatEmailDeliveryFailedLogMessage } from "../../src/lib/email/delivery-failure-log.ts";
import type { EmailDeliveryStatus } from "../../src/lib/email/delivery.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function sinceIso(raw: string | undefined): string {
  const m = /^(\d+)d$/.exec(raw ?? "");
  if (m) return new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString();
  return raw ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
}
const SINCE = sinceIso(argValue("--since"));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

const ALREADY = "Outreach follow-up cancelled";
const PAGE = 500;

type ProspectRow = { email: string | null };
const retiredEmails = new Set<string>();
for (let from = 0; ; from += PAGE) {
  const { data: page, error } = await db
    .from("outreach_prospects")
    .select("email")
    .eq("status", "failed")
    .ilike("status_detail", "pitch bounced%")
    .range(from, from + PAGE - 1);
  if (error) {
    console.error(`read outreach_prospects: ${error.message}`);
    process.exit(1);
  }
  const batch = (page ?? []) as ProspectRow[];
  for (const row of batch) {
    const email = row.email?.trim().toLowerCase();
    if (email) retiredEmails.add(email);
  }
  if (batch.length < PAGE) break;
}

type LogRow = {
  id: string;
  event: string;
  message: string | null;
  payload: Record<string, unknown> | null;
};
const logRows: LogRow[] = [];
for (let from = 0; ; from += PAGE) {
  const { data: page, error } = await db
    .from("system_logs")
    .select("id, event, message, payload")
    .eq("source", "email")
    .in("event", ["email_delivery_failed", "email_delivery_failed_unattributed"])
    .gte("created_at", SINCE)
    .order("created_at", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) {
    console.error(`read system_logs: ${error.message}`);
    process.exit(1);
  }
  const batch = (page ?? []) as LogRow[];
  logRows.push(...batch);
  if (batch.length < PAGE) break;
}

let rewritten = 0;
let skipped = 0;
const touched: string[] = [];

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: ${retiredEmails.size} retired outreach address(es), ` +
    `${logRows.length} delivery-failure log(s) since ${SINCE.slice(0, 10)}\n`
);

for (const row of logRows) {
  const payload = (row.payload ?? {}) as {
    to?: unknown;
    status?: unknown;
  };
  const to = typeof payload.to === "string" ? payload.to.trim().toLowerCase() : "";
  if (!to || !retiredEmails.has(to)) continue;
  if ((row.message ?? "").includes(ALREADY)) {
    skipped++;
    continue;
  }
  const status = (
    payload.status === "failed" || payload.status === "bounced" ? payload.status : "bounced"
  ) as EmailDeliveryStatus;
  const next = formatEmailDeliveryFailedLogMessage({
    status,
    to: typeof payload.to === "string" ? payload.to : to,
    retiredCount: 1,
    unattributed: row.event === "email_delivery_failed_unattributed"
  });
  console.log(`  ${APPLY ? "REWRITE" : "would rewrite"} ${row.id}`);
  if (!APPLY) {
    rewritten++;
    continue;
  }
  const nextPayload = { ...(row.payload ?? {}), outreachRetired: 1 };
  const { data: updated, error: updateErr } = await db
    .from("system_logs")
    .update({ message: next, payload: nextPayload })
    .eq("id", row.id)
    .select("id");
  if (updateErr) {
    console.error(`      update failed: ${updateErr.message}`);
    continue;
  }
  if ((updated ?? []).length === 0) {
    console.error(`      update matched no rows; left alone`);
    continue;
  }
  rewritten++;
  touched.push(row.id);
}

console.log(
  `\n${APPLY ? `Rewrote ${rewritten}` : `Would rewrite ${rewritten}`} log(s)` +
    `${skipped > 0 ? `, ${skipped} skipped` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to land it.");
} else if (rewritten > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "rewrite-outreach-bounce-log-copy.ts",
    businessId: null,
    details: { rewritten, skipped, since: SINCE, log_ids: touched }
  });
}
