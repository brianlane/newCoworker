#!/usr/bin/env tsx
/**
 * "Did that email actually arrive?" Read the delivery receipts.
 *
 * Until 2026-08-26 the answer was unknowable. `sendOwnerEmail` returning an
 * id meant Resend ACCEPTED the message, nothing consumed Resend's delivery
 * webhooks, and the alert emails did not even get a row: the notifications
 * table recorded that we decided to alert and that the send call returned,
 * which is not the same claim as "it arrived". A tenant whose owner had
 * silently stopped receiving mail looked exactly like a healthy one.
 *
 * This is the email twin of debug/whatsapp-delivery-report.ts, and it exists
 * for the same reason: an owner with no working SMS and no WhatsApp billing
 * has email as the ONLY channel left, and it was the one we could say least
 * about.
 *
 * Reading the output:
 *   delivered / sent / delayed   on its way or arrived
 *   bounced / complained / failed  did NOT reach the owner
 *   pending                      a receipt has not arrived yet (usually
 *                                seconds; a stuck one is worth a look)
 *   never-captured               sent before the webhook was live, so no
 *                                receipt was ever going to arrive
 *   no-id                        the caller logged no provider id, so no
 *                                receipt can ever match the row
 *
 * The last two are NOT failures and are never resolvable. They are split
 * from `pending` on purpose: a row that will never resolve and a row still
 * waiting are the same thing to the database and completely different things
 * to whoever is reading this.
 *
 * Strictly READ-ONLY. Safe on any tenant.
 *
 * Usage:
 *   tsx debug/email-delivery-report.ts
 *   tsx debug/email-delivery-report.ts --business <uuid> --since 7d
 *   tsx debug/email-delivery-report.ts --failed-only
 *   tsx debug/email-delivery-report.ts --alerts-only
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

/** The states that mean the owner did not read it and will not. */
const FAILURE_STATES = ["bounced", "complained", "failed"];

/**
 * When the receipt webhook went live in production (the Vercel deploy of
 * PR #1628 completed 2026-08-26T05:37:47Z).
 *
 * Anything sent before this has a provider id but will NEVER get a receipt:
 * nothing was listening when Resend fired it. Without this cutoff those rows
 * report as `pending`, which reads as "these are stuck" and is exactly the
 * kind of misreading this whole feature exists to prevent. On the first run
 * after deploy that was 109 rows.
 */
const RECEIPTS_LIVE_AT = Date.parse("2026-08-26T05:37:47Z");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function sinceIso(raw: string | null): string {
  const m = /^(\d+)([dh])$/.exec(raw ?? "7d");
  const n = m ? Number(m[1]) : 7;
  const ms = m?.[2] === "h" ? n * 3600_000 : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const businessId = arg("business");
  const from = sinceIso(arg("since"));
  const failedOnly = process.argv.includes("--failed-only");
  const alertsOnly = process.argv.includes("--alerts-only");

  let q = sb
    .from("email_log")
    // One string literal, not a concatenation: supabase-js infers the row
    // type from the literal, and a `+` here collapses it to GenericStringError.
    .select("business_id, created_at, to_email, subject, source, provider_message_id, delivery_status, delivery_error_code, delivery_error_message")
    .eq("direction", "outbound")
    .gte("created_at", from)
    .order("created_at", { ascending: false })
    // Explicit, because an un-limited PostgREST select silently truncates at
    // 1000 rows and a truncated report reads as a quiet week.
    .limit(1000);
  if (businessId) q = q.eq("business_id", businessId);
  if (alertsOnly) q = q.eq("source", "notification");
  if (failedOnly) q = q.in("delivery_status", FAILURE_STATES);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  const { data: biz } = await sb.from("businesses").select("id, name");
  const nameOf = new Map((biz ?? []).map((b) => [b.id as string, b.name as string]));

  const tally: Record<string, number> = {};
  for (const r of rows) {
    // No provider id at all means no receipt can ever match this row, which
    // is a different thing from a receipt that has not arrived yet.
    let state: string;
    if (!r.provider_message_id) {
      state = "no-id";
    } else if (r.delivery_status) {
      state = r.delivery_status;
    } else {
      state =
        Date.parse(String(r.created_at)) < RECEIPTS_LIVE_AT ? "never-captured" : "pending";
    }
    tally[state] = (tally[state] ?? 0) + 1;
  }

  const scope = [
    businessId ? ` for ${businessId}` : "",
    alertsOnly ? " (alerts only)" : ""
  ].join("");
  console.log(`Outbound email since ${from}${scope}\n`);
  if (rows.length === 1000) {
    console.log("  NOTE: hit the 1000-row cap, narrow with --since or --business\n");
  }
  for (const [state, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${state}`);
  }

  const failures = rows.filter((r) => FAILURE_STATES.includes(String(r.delivery_status)));
  if (failures.length > 0) {
    console.log(`\nDid not reach the recipient (${failures.length}):`);
    for (const f of failures) {
      console.log(
        `\n  [${f.created_at}] ${nameOf.get(f.business_id as string) ?? f.business_id}` +
          `\n    ${f.delivery_status}  to=${f.to_email ?? "-"}  source=${f.source}` +
          `\n    code=${f.delivery_error_code ?? "-"}  ${f.delivery_error_message ?? ""}` +
          `\n    ${String(f.subject ?? "").slice(0, 120).replace(/\n/g, " ")}`
      );
    }
  } else if (!failedOnly) {
    console.log("\nNo failed deliveries in this window.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
