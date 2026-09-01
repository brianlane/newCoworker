/**
 * retire-bounced-outreach-prospects.ts: stop follow-up nudges to prospects
 * whose pitch provably BOUNCED.
 *
 * Background (2026-08-28 investigation). HQ's outreach pitches leave through
 * the owner's Gmail, whose default send-as identity relays delivery through
 * Resend's SMTP (see .cursor/memory/project_hq_gmail_sendas_resend_relay.md).
 * Resend's receipt webhook therefore reports the bounces, but until the
 * recipient+subject fallback shipped, only as
 * `email_delivery_failed_unattributed` rows in system_logs, while the
 * prospect ledger kept saying `sent`. A prospect at `sent` with no reply is
 * exactly what the sweep nudges five days later, so every bounced pitch was
 * queued to re-mail a known-dead address: bad for the recipient, bad for the
 * sending domain's reputation, and the nudge burns the one follow-up the
 * prospect will ever get on an email that cannot arrive.
 *
 * EVIDENCE, NOT A HAND-TYPED LIST. The bounced recipients are read from
 * system_logs (`email_delivery_failed` + `email_delivery_failed_unattributed`,
 * source `email`, status `bounced`/`failed` in the payload), then matched to
 * `outreach_prospects` rows still at `sent` with the same address; when the
 * receipt carried a subject it must also equal the prospect's pitch subject
 * (first pitch and nudge share it by design). Nothing tenant-specific is
 * hardcoded, so the same script covers any tenant the relay gap bit.
 *
 * WHAT IT WRITES. `status: sent -> failed` (which is what removes the row
 * from listProspectsDueForNudge), with a status_detail naming the bounce.
 * `sent_at` is KEPT: the pitch really did go out, and countProspectsSentSince
 * keys the daily cap on it. `replied_at`/`nudged_at` are untouched; a row
 * with either set is skipped, since a reply proves delivery and a sent nudge
 * means the follow-up already happened.
 *
 * The LIVE path is `retireProspectsOnBounce` in src/lib/outreach/bounce.ts,
 * called from the Resend delivery webhook as the receipt arrives. This
 * script remains the backfill for receipts that landed before that shipped.
 *
 * Idempotent: the update is guarded on `status = sent`, so a retired row is
 * skipped on re-run (reported as already retired).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/retire-bounced-outreach-prospects.ts                # dry run, 7d window
 *   npx tsx scripts/oneshot/retire-bounced-outreach-prospects.ts --since 14d
 *   npx tsx scripts/oneshot/retire-bounced-outreach-prospects.ts --business <uuid>
 *   npx tsx scripts/oneshot/retire-bounced-outreach-prospects.ts --apply       # land it
 */
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? null;

/** `--since 14d` or an ISO date; default one week, comfortably past the day-5 nudge. */
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
const db = createClient(url, key, { auth: { persistSession: false } });

type BouncePayload = {
  to?: string;
  subject?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
};

// 1) The evidence: delivery-failure receipts since the window opened. PAGED,
//    not capped: the webhook now logs an attributed `email_delivery_failed`
//    for EVERY failed message on the account, so a single `.limit()` over a
//    busy window would read the OLDEST rows and silently drop the newest
//    receipts (PostgREST truncates without an error), which is exactly the
//    half a re-run needs (Bugbot, PR #1695).
const PAGE = 500;
type LogRow = { created_at: string; payload: unknown };
const logRows: LogRow[] = [];
for (let from = 0; ; from += PAGE) {
  const { data: page, error: logErr } = await db
    .from("system_logs")
    .select("created_at, event, payload")
    .eq("source", "email")
    .in("event", ["email_delivery_failed", "email_delivery_failed_unattributed"])
    .gte("created_at", SINCE)
    .order("created_at", { ascending: true })
    .range(from, from + PAGE - 1);
  if (logErr) {
    console.error(`read system_logs: ${logErr.message}`);
    process.exit(1);
  }
  const batch = (page ?? []) as LogRow[];
  logRows.push(...batch);
  if (batch.length < PAGE) break;
}

type BounceReceipt = { subject: string | null; detail: string; at: string };

/**
 * EVERY failure receipt per recipient (lowercased address), oldest first.
 * All of them are kept rather than the newest only: the same address can
 * bounce again later under a different subject (an owner alert, a campaign),
 * and letting that receipt replace the pitch's would make the pitch look
 * unmatched and leave the prospect in the nudge queue (Bugbot, PR #1695).
 */
const bounces = new Map<string, BounceReceipt[]>();
for (const row of logRows) {
  const p = (row.payload ?? {}) as BouncePayload;
  const to = p.to?.trim().toLowerCase();
  if (!to) continue;
  // Bounced/failed only: a `complained` recipient received the mail, and
  // whether to keep talking to them is an owner decision, not a data repair.
  if (p.status !== "bounced" && p.status !== "failed") continue;
  const list = bounces.get(to) ?? [];
  list.push({
    subject: p.subject?.trim() || null,
    detail: `${p.status}${p.errorCode ? ` (${p.errorCode})` : ""}${
      p.errorMessage ? `: ${p.errorMessage}` : ""
    }`.slice(0, 260),
    at: String(row.created_at)
  });
  bounces.set(to, list);
}

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: ${bounces.size} bounced recipient(s) in system_logs since ` +
    `${SINCE.slice(0, 10)}${BUSINESS_ID ? `, prospects filtered to business ${BUSINESS_ID}` : ""}\n`
);

/** Escape `%`, `_`, and `\` so the address matches literally under ILIKE. */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

let retired = 0;
let alreadyRetired = 0;
let skipped = 0;
const touched: Record<string, unknown>[] = [];

for (const [to, receipts] of bounces) {
  // 2) The prospects that pitched this address, any status, so the report can
  //    say "already retired" instead of silently finding nothing on a re-run.
  let query = db
    .from("outreach_prospects")
    .select("id, business_id, domain, business_name, email, status, status_detail, pitch_subject, sent_at, nudged_at, replied_at")
    .ilike("email", escapeIlike(to))
    .order("sent_at", { ascending: false })
    .limit(10);
  if (BUSINESS_ID) query = query.eq("business_id", BUSINESS_ID);
  const { data: prospects, error: readErr } = await query;
  if (readErr) {
    console.error(`read outreach_prospects for a recipient: ${readErr.message}`);
    process.exit(1);
  }
  if (!prospects || prospects.length === 0) continue; // not outreach mail (an alert, a campaign)

  for (const prospect of prospects) {
    const label = `${prospect.domain}  (${prospect.business_name}, ${to})`;
    // The newest receipt that could be about THIS pitch. Three conditions,
    // each closing a real mis-match:
    //   - it must POSTDATE the pitch's send (receipt `at` is our own
    //     system_logs clock, which is always after the sent_at claim stamp),
    //     or an old bounce of unrelated mail to the same address would
    //     retire a later pitch that delivered fine (Bugbot, PR #1695);
    //   - a receipt naming a subject must name the pitch's (first pitch and
    //     nudge share it by design), while a subjectless receipt matches;
    //   - searched newest first across ALL of the address's receipts, so an
    //     unrelated later bounce cannot shadow the one that matches.
    const sentAtMs = prospect.sent_at ? Date.parse(String(prospect.sent_at)) : NaN;
    const bounce = [...receipts]
      .reverse()
      .find(
        (r) =>
          (Number.isNaN(sentAtMs) || Date.parse(r.at) >= sentAtMs) &&
          (!r.subject || !prospect.pitch_subject || r.subject === prospect.pitch_subject)
      );
    if (!bounce) {
      console.log(`  SKIP ${label}: no bounce receipt matches this pitch (subject and send time)`);
      skipped++;
      continue;
    }
    if (prospect.status !== "sent") {
      const priorRetire = prospect.status === "failed";
      console.log(
        `  ${priorRetire ? "OK  " : "SKIP"} ${label}: status is "${prospect.status}"` +
          `${priorRetire ? " (already retired)" : ", not touching a row the ledger moved elsewhere"}`
      );
      if (priorRetire) alreadyRetired++;
      else skipped++;
      continue;
    }
    if (prospect.replied_at) {
      console.log(`  SKIP ${label}: the prospect replied, so the mail demonstrably arrived`);
      skipped++;
      continue;
    }
    if (prospect.nudged_at) {
      console.log(`  SKIP ${label}: the one follow-up already went out, nothing left to stop`);
      skipped++;
      continue;
    }

    const detail = `pitch bounced, follow-up cancelled: ${bounce.detail}`;
    console.log(
      `  ${APPLY ? "RETIRE" : "would retire"} ${label}\n` +
        `      ${bounce.detail}\n` +
        `      sent_at kept (${prospect.sent_at}), status -> failed`
    );
    touched.push({
      prospect_id: prospect.id,
      business_id: prospect.business_id,
      domain: prospect.domain,
      bounced_at: bounce.at
    });
    if (!APPLY) continue;

    const { data: updated, error: updateErr } = await db
      .from("outreach_prospects")
      .update({ status: "failed", status_detail: detail })
      .eq("business_id", prospect.business_id)
      .eq("id", prospect.id)
      // Guarded on the status we read: the sweep moving the row meanwhile
      // (a reply arriving right now) wins, and a re-run converges to no-op.
      .eq("status", "sent")
      .select("id");
    if (updateErr) {
      console.error(`      update failed: ${updateErr.message}`);
      continue;
    }
    // A PostgREST update matching zero rows returns no error; the returned
    // rows are the only proof the retire landed.
    if ((updated ?? []).length === 0) {
      console.error(`      update matched no rows (row changed underneath us); left alone`);
      continue;
    }
    retired++;
  }
}

console.log(
  `\n${APPLY ? `Retired ${retired} prospect(s)` : `Would retire ${touched.length} prospect(s)`}` +
    `${alreadyRetired > 0 ? `, ${alreadyRetired} already retired` : ""}` +
    `${skipped > 0 ? `, ${skipped} skipped` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to land it.");
} else if (retired > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "retire-bounced-outreach-prospects.ts",
    businessId: BUSINESS_ID,
    details: { retired, already_retired: alreadyRetired, skipped, since: SINCE, prospects: touched }
  });
}
