/**
 * alert-bounced-contact-email.ts: tell a tenant about an email their AI
 * coworker sent to a CONTACT that bounced BEFORE the live alert existed.
 *
 * Background (KYP Ads / Vantage Flow Media, 2026-09-03). A lead booked a
 * strategy call on Calendly with a work address whose mailbox did not exist.
 * The flow's booking-confirmation email hard-bounced at Google; Calendly's own
 * confirmation and calendar invite went to the same dead address. The receipt
 * webhook recorded it faithfully, as `email_delivery_failed` at level `error`
 * on the admin System Errors card, which the tenant never sees, and that was
 * the only place it went. The lead had our confirmation text and nothing
 * else; the person who could fix it (text the lead, send the invite to the
 * address on the lead form) was never told.
 *
 * The LIVE path is now `notifyContactEmailBounce`
 * (src/lib/notifications/contact-email-bounce-notify.ts), called from the
 * Resend webhook as each failure lands. This script is the backfill for
 * receipts that landed before that shipped: it reads the bounced
 * customer-facing rows from `email_log`, skips any the live path (or a prior
 * run) has already alerted, and pushes the rest through the SAME notifier, so
 * the owner gets exactly the alert they would have gotten on the day.
 *
 * EVIDENCE, NOT A HAND-TYPED LIST. Rows come from `email_log.delivery_status`
 * (the Resend receipt), filtered to the customer-facing `source` values the
 * notifier itself defines. Nothing tenant-specific is hardcoded.
 *
 * Residency note: `email_log` is one of the tables `residency_purge_business()`
 * deletes centrally after the 72h keep floor for a `vps` tenant, so a bounce
 * older than that on such a tenant may already be gone from the central copy
 * and will simply not be listed. The window default keeps this honest rather
 * than pretending to be exhaustive.
 *
 * Idempotent: a row that already has a `contact_email_bounce` notification
 * naming its `email_log_id` is reported as already alerted and skipped, and
 * the notifier's own 24h per-contact throttle stands behind that.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/alert-bounced-contact-email.ts                       # dry run, fleet, 7d
 *   npx tsx scripts/oneshot/alert-bounced-contact-email.ts --business <uuid>
 *   npx tsx scripts/oneshot/alert-bounced-contact-email.ts --email-log-id <uuid> # one row
 *   npx tsx scripts/oneshot/alert-bounced-contact-email.ts --since 14d
 *   npx tsx scripts/oneshot/alert-bounced-contact-email.ts ... --apply           # send the alerts
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? null;
const EMAIL_LOG_ID = argValue("--email-log-id") ?? null;

/** `--since 14d` or an ISO date; default one week. */
function sinceIso(raw: string | undefined): string {
  const m = /^(\d+)d$/.exec(raw ?? "");
  if (m) return new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString();
  return raw ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
}
const SINCE = sinceIso(argValue("--since"));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const {
  isCustomerFacingEmailSource,
  notifyContactEmailBounce
} = await import("../../src/lib/notifications/contact-email-bounce-notify.ts");

const db = createClient(url, key, { auth: { persistSession: false } });

type BouncedRow = {
  id: string;
  business_id: string;
  source: string;
  to_email: string | null;
  subject: string | null;
  run_id: string | null;
  flow_id: string | null;
  delivery_status: "bounced" | "complained" | "failed";
  delivery_error_code: string | null;
  delivery_updated_at: string | null;
  created_at: string;
};

// 1) The evidence: customer-facing outbound rows whose receipt says the mail
//    did not arrive. Bounded to the window and capped well above anything a
//    week of the fleet produces (one so far), so the cap cannot truncate.
let query = db
  .from("email_log")
  .select(
    "id, business_id, source, to_email, subject, run_id, flow_id, delivery_status, delivery_error_code, delivery_updated_at, created_at"
  )
  .eq("direction", "outbound")
  .in("delivery_status", ["bounced", "complained", "failed"])
  .gte("created_at", SINCE)
  .order("created_at", { ascending: true })
  .limit(500);
if (BUSINESS_ID) query = query.eq("business_id", BUSINESS_ID);
if (EMAIL_LOG_ID) query = query.eq("id", EMAIL_LOG_ID);
const { data, error } = await query;
if (error) {
  console.error(`read email_log: ${error.message}`);
  process.exit(1);
}
const rows = ((data ?? []) as BouncedRow[]).filter((row) =>
  isCustomerFacingEmailSource(row.source)
);

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: ${rows.length} bounced customer-facing email(s) since ${SINCE.slice(0, 10)}` +
    `${BUSINESS_ID ? `, business ${BUSINESS_ID}` : ", fleet-wide"}` +
    `${EMAIL_LOG_ID ? `, row ${EMAIL_LOG_ID}` : ""}\n`
);

let alerted = 0;
let alreadyAlerted = 0;
let skipped = 0;
const touched: Record<string, unknown>[] = [];

for (const row of rows) {
  const label = `${row.created_at.slice(0, 16)}  ${row.business_id.slice(0, 8)}  ${row.source}  ${row.delivery_status}` +
    `${row.delivery_error_code ? ` (${row.delivery_error_code})` : ""}  to ${row.to_email ?? "?"}  | ${row.subject ?? ""}`;

  if (!row.to_email) {
    console.log(`  SKIP ${label}: the row has no recipient to describe`);
    skipped++;
    continue;
  }

  // 2) Idempotence: the live path (or a prior run) already told the owner.
  const { count, error: seenErr } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("business_id", row.business_id)
    .eq("kind", "contact_email_bounce")
    .eq("payload->>email_log_id", row.id);
  if (seenErr) {
    console.error(`  read notifications for ${row.id}: ${seenErr.message}`);
    process.exit(1);
  }
  if ((count ?? 0) > 0) {
    console.log(`  OK   ${label}: already alerted (${count} notification row(s))`);
    alreadyAlerted++;
    continue;
  }

  console.log(`  ${APPLY ? "ALERT" : "would alert"} ${label}`);
  touched.push({
    email_log_id: row.id,
    business_id: row.business_id,
    to: row.to_email,
    status: row.delivery_status,
    bounced_at: row.delivery_updated_at ?? row.created_at
  });
  if (!APPLY) continue;

  const result = await notifyContactEmailBounce({
    businessId: row.business_id,
    emailLogId: row.id,
    address: row.to_email,
    subject: row.subject,
    status: row.delivery_status,
    errorCode: row.delivery_error_code,
    runId: row.run_id,
    flowId: row.flow_id
  });
  console.log(`        -> ${result.outcome}${result.contactE164 ? `, contact ${result.contactE164}` : ""}`);
  touched[touched.length - 1] = { ...touched[touched.length - 1], ...result };
  if (result.outcome === "alerted") alerted++;
  else if (result.outcome === "alerted_earlier") alreadyAlerted++;
  else skipped++;
}

console.log(
  `\n${APPLY ? `Alerted ${alerted} owner(s)` : `Would alert ${touched.length} owner(s)`}` +
    `${alreadyAlerted > 0 ? `, ${alreadyAlerted} already alerted` : ""}` +
    `${skipped > 0 ? `, ${skipped} skipped` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to send them.");
} else if (touched.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "alert-bounced-contact-email.ts",
    businessId: BUSINESS_ID,
    details: { alerted, already_alerted: alreadyAlerted, skipped, since: SINCE, rows: touched }
  });
}
