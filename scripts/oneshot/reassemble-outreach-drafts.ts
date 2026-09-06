/**
 * reassemble-outreach-drafts.ts: rebuild the WAITING outreach drafts' closing
 * line under the current booking-link rule, keeping every word the owner or
 * the coworker wrote.
 *
 * Why it exists. `outreach_prospects.pitch_body` is assembled when a draft is
 * written and sent verbatim: the sweep never re-reads the settings at send
 * time (README, Prospecting: the footer is structural, and the panel shows
 * the body "as it will send"). So when the first-touch booking link was made
 * optional and switched OFF by default (Sep 2026, the zero-reply fix), every
 * draft already in the queue still carried "You can grab a time here: ...",
 * and in automatic mode those drafts go out on the next in-window pass with
 * the calendar ask the change exists to remove. On HQ that was 21 drafts.
 *
 * "Write it again (for all drafts)" is not the answer: it re-COMPOSES from
 * the probe findings, replaces owner edits, and refuses the connector-filed
 * drafts (no findings) outright. This keeps the subject and paragraphs
 * exactly as stored and only re-runs the assembly, through the same
 * `editProspectDraft` the dashboard's Save draft uses, so the CTA follows
 * `outreach_settings.booking_link_on_first_touch` and each row's own
 * `include_booking_link` override, and the sign-off, unsubscribe link, and
 * postal address are rebuilt by the same code as always.
 *
 * What it touches: rows at `drafted` with stored paragraphs. Legacy drafts
 * (null `pitch_paragraphs`, written before the editor existed) are reported
 * and skipped: there is nothing owner-safe to re-assemble around, and Write
 * it again on the dashboard is the right tool for those. Nothing sent,
 * skipped, replied, or failed is ever read, let alone written.
 *
 * Idempotent: a draft whose stored body already equals the re-assembled one
 * is reported as current and not written. `editProspectDraft` is guarded on
 * the row still being `drafted`, so a draft the sweep sends mid-run is left
 * alone and reported.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/reassemble-outreach-drafts.ts --business <uuid>          # dry run
 *   npx tsx scripts/oneshot/reassemble-outreach-drafts.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business");
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("usage: --business <uuid> [--apply]");
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}
// The library resolves its own client from the same env; `createSupabaseServiceClient`
// reads NEXT_PUBLIC_SUPABASE_URL only, so mirror SUPABASE_URL into it when that is
// the one the .env carries.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= url;

const { createClient } = await import("@supabase/supabase-js");
const { getOutreachSettings, listProspectsByStatus } = await import("../../src/lib/outreach/db.ts");
const { editProspectDraft } = await import("../../src/lib/outreach/sweep.ts");

const db = createClient(url, key, { auth: { persistSession: false } });

const settings = await getOutreachSettings(BUSINESS_ID, db as never);
if (!settings) {
  console.error(`business ${BUSINESS_ID} has no outreach_settings row; nothing to re-assemble`);
  process.exit(1);
}
// Before migration 20260906033938 lands the column is simply absent from the
// row, and `editProspectDraft` would then fail on the write of
// `include_booking_link`. Say so instead of half-applying.
const migrated = typeof settings.booking_link_on_first_touch === "boolean";
if (!migrated) {
  console.error(
    "outreach_settings.booking_link_on_first_touch is missing: migration " +
      "20260906033938 has not been applied to this database yet. Dry run continues; " +
      "--apply refuses until the deploy has landed."
  );
  if (APPLY) process.exit(1);
}

/** Every waiting draft. The ledger scan bound is generous next to any real queue. */
const drafted = await listProspectsByStatus(BUSINESS_ID, ["drafted"], 1000, db as never);

const BOOKING_LINE = "You can grab a time here: ";
const REPLY_LINE = "Just reply if you want to hear more.";

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: ${drafted.length} waiting draft(s) for business ${BUSINESS_ID}\n` +
    `  tenant default booking_link_on_first_touch = ${
      migrated ? settings.booking_link_on_first_touch : "(column not migrated yet; will be false)"
    }\n`
);

let rewritten = 0;
let current = 0;
let legacy = 0;
let lost = 0;
const touched: Array<Record<string, unknown>> = [];

for (const row of drafted) {
  const label = `${row.domain}  (${row.business_name})`;
  const subject = row.pitch_subject?.trim() ?? "";
  const paragraphs = row.pitch_paragraphs?.trim() ?? "";
  if (!subject || !paragraphs) {
    console.log(`  SKIP ${label}: legacy draft with no stored paragraphs (use Write it again)`);
    legacy++;
    continue;
  }
  const body = row.pitch_body ?? "";
  const hasLink = body.includes(BOOKING_LINE);
  // `?? null` on both reads: before the migration the columns are absent
  // (undefined), and the dry run should still describe the post-deploy result.
  const rowOverride = row.include_booking_link ?? null;
  const wantsLink = rowOverride ?? settings.booking_link_on_first_touch ?? false;
  // A tenant with no booking link at all already prints the reply ask; the
  // apply below is still exact (it re-runs the real assembly), this is only
  // the dry run's best statement of what will change.
  const cta = hasLink ? "booking link" : body.includes(REPLY_LINE) ? "reply ask" : "unknown";
  const target = wantsLink ? "booking link" : "reply ask";
  const override = rowOverride === null ? "tenant default" : `row override ${rowOverride}`;

  if (!APPLY) {
    const change = cta === target ? "current" : `would rewrite (${cta} -> ${target})`;
    console.log(`  ${change.padEnd(40)} ${label}  [${override}]`);
    if (cta !== target) touched.push({ prospect_id: row.id, domain: row.domain, from: cta, to: target });
    continue;
  }

  // The real assembly, through the dashboard's own edit path: same tenant
  // resolution, same footer, same drafted-only guard. Paragraphs unchanged.
  const result = await editProspectDraft(BUSINESS_ID, row.id, { subject, paragraphs });
  if (!result.ok) {
    console.log(`  LOST ${label}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    lost++;
    continue;
  }
  if (result.prospect.pitch_body === body) {
    console.log(`  current  ${label}  [${override}]`);
    current++;
    continue;
  }
  const after = result.prospect.pitch_body.includes(BOOKING_LINE) ? "booking link" : "reply ask";
  console.log(`  REWROTE  ${label}: ${cta} -> ${after}  [${override}]`);
  rewritten++;
  touched.push({ prospect_id: row.id, domain: row.domain, from: cta, to: after });
}

if (!APPLY) {
  console.log(
    `\nWould rewrite ${touched.length} draft(s)` +
      `${legacy > 0 ? `, ${legacy} legacy skipped` : ""}. Re-run with --apply to land it.`
  );
} else {
  console.log(
    `\nRewrote ${rewritten} draft(s), ${current} already current` +
      `${legacy > 0 ? `, ${legacy} legacy skipped` : ""}${lost > 0 ? `, ${lost} moved on under us` : ""}.`
  );
  if (rewritten > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "reassemble-outreach-drafts.ts",
      businessId: BUSINESS_ID,
      details: {
        rewritten,
        current,
        legacy,
        lost,
        booking_link_on_first_touch: settings.booking_link_on_first_touch,
        prospects: touched
      }
    });
  }
}
