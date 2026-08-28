/**
 * repoint-roster-member-phone.ts: move an existing roster row onto a
 * different phone (and optionally set its email), IN PLACE.
 *
 * Why this exists rather than `apply-vfm-team.ts`. That script upserts by
 * (business, phone), so handing it a new number INSERTS a second roster row
 * instead of correcting the first. For a one-person roster that is actively
 * harmful: `pickSoloOwner` / `pickImplicitContactOwner` bail on
 * `roster.length !== 1`, so a duplicate would silently switch the tenant
 * from contact-owner paging to team-broadcast claim invites. This script
 * only ever UPDATEs a row that already exists, and refuses anything that
 * would change the roster's size.
 *
 * The situation it was written for (KYP Ads, Aug 2026). James Lee's roster
 * row carried his Hong Kong mobile. Telnyx long codes cannot originate SMS
 * outside NANP at all (ticket #557577), so every team/lead-offer text to
 * that row failed with 409/40306 "Alpha sender not configured" and raised an
 * `alert_delivery_failed` system error, while the same alert still reached
 * him by email and dashboard. The +852 number also meant he never matched
 * his own owner numbers, so `soloOwnerVerdict` returned null and every
 * contact-scoped alert routed as `team_broadcast` / `contact_unowned`,
 * which in turn meant the roster email was never consulted at all
 * (dispatch.ts only reads it when `emailTarget === "contact_owner"`).
 *
 * So the phone is the load-bearing field: correcting it fixes the failing
 * texts, the routing, and the email target together.
 *
 * Guards, all refusals rather than warnings:
 *   - the target must be SMS-reachable (`smsReachability` === "nanp"), since
 *     repointing onto another unreachable number just moves the outage;
 *     `--allow-unreachable` overrides for a deliberate non-SMS roster row.
 *   - the target must not already belong to ANOTHER row on this business
 *     (`unique (business_id, phone_e164)` would reject the write, and a
 *     merge is a different, lossier operation than a repoint).
 *   - exactly one row must match the selector.
 *
 * Claims and offers are unaffected: every claim table references the member
 * by `id` (FK), not by number, so a repoint keeps existing rows attached.
 * Inbound claim-by-"1" matches the SENDER against `phone_e164`
 * (telnyx-sms-inbound), which is precisely what starts working again.
 *
 * Usage (ids/PII from argv or env, never hard-coded):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/repoint-roster-member-phone.ts \
 *     --business <uuid> --from-phone +8520000000 --to-phone +15550000000 \
 *     [--email name@example.com]
 *   ... --apply   # write
 *
 * Selector: `--member <uuid>` or `--from-phone <e164>`, exactly one.
 * Idempotent: a row already holding the target reports "no change" and
 * exits 0. Dry-run by default. Ledger-recorded on apply.
 */
import { loadEnv } from "../../debug/_shared.ts";
import { smsReachability } from "../../src/lib/phone/deliverability.ts";

loadEnv();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const ALLOW_UNREACHABLE = process.argv.includes("--allow-unreachable");
const BUSINESS_ID = argValue("--business") ?? process.env.ROSTER_BUSINESS_ID;
const MEMBER_ID = argValue("--member") ?? process.env.ROSTER_MEMBER_ID;
const FROM_PHONE = (argValue("--from-phone") ?? process.env.ROSTER_FROM_PHONE)?.trim();
const TO_PHONE = (argValue("--to-phone") ?? process.env.ROSTER_TO_PHONE)?.trim();
const EMAIL = (argValue("--email") ?? process.env.ROSTER_MEMBER_EMAIL)?.trim().toLowerCase();

/** The table's own CHECK constraint, so a bad value fails here not at the DB. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

function fail(message: string): never {
  console.error(`[oneshot] ${message}`);
  process.exit(1);
}

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  fail("pass --business <uuid> (or set ROSTER_BUSINESS_ID)");
}
if (!MEMBER_ID && !FROM_PHONE) {
  fail("pass --member <uuid> or --from-phone <e164> to select the row");
}
if (MEMBER_ID && FROM_PHONE) {
  fail("pass EITHER --member or --from-phone, not both: the selector must be unambiguous");
}
if (!TO_PHONE) {
  fail("pass --to-phone <e164> (or set ROSTER_TO_PHONE)");
}
if (!E164.test(TO_PHONE)) {
  fail(`--to-phone must be E.164 (+15550000000), got: ${TO_PHONE}`);
}
if (FROM_PHONE && !E164.test(FROM_PHONE)) {
  fail(`--from-phone must be E.164, got: ${FROM_PHONE}`);
}
if (EMAIL && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL)) {
  fail(`--email does not look like an address: ${EMAIL}`);
}

// The whole point of the script: refuse to repoint onto a number our long
// codes still cannot text. `--allow-unreachable` is for a roster row that is
// deliberately email/voice-only.
const reachability = smsReachability(TO_PHONE);
if (reachability !== "nanp" && !ALLOW_UNREACHABLE) {
  fail(
    `--to-phone ${TO_PHONE} classifies as "${reachability}": our long codes only ` +
      "originate SMS to +1 (US/CA), so team texts to it would keep failing. " +
      "Pass --allow-unreachable to do it anyway."
  );
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, phone")
  .eq("id", BUSINESS_ID)
  .maybeSingle();
if (bizErr || !biz) {
  fail(`business not found: ${bizErr?.message ?? BUSINESS_ID}`);
}

const { data: roster, error: rosterErr } = await db
  .from("ai_flow_team_members")
  .select("id, name, phone_e164, email, active")
  .eq("business_id", BUSINESS_ID)
  .order("created_at", { ascending: true });
if (rosterErr) {
  fail(`roster read failed: ${rosterErr.message}`);
}
const members = (roster ?? []) as Array<{
  id: string;
  name: string;
  phone_e164: string;
  email: string | null;
  active: boolean;
}>;

const matches = MEMBER_ID
  ? members.filter((m) => m.id === MEMBER_ID)
  : members.filter((m) => m.phone_e164 === FROM_PHONE);
if (matches.length === 0) {
  fail(`no roster row matches ${MEMBER_ID ? `--member ${MEMBER_ID}` : `--from-phone ${FROM_PHONE}`}`);
}
if (matches.length > 1) {
  // Unreachable via --from-phone (unique constraint) but not via a future
  // selector; refuse rather than guess which row was meant.
  fail(`selector matched ${matches.length} rows; refusing to guess`);
}
const target = matches[0];

// `unique (business_id, phone_e164)`: another row already holding the target
// makes this a MERGE (two people, one number), which loses a roster row and
// is not what "repoint" means. Refuse and let a human decide.
const collision = members.find((m) => m.phone_e164 === TO_PHONE && m.id !== target.id);
if (collision) {
  fail(
    `roster row ${collision.id} ("${collision.name}") already holds ${TO_PHONE}. ` +
      "Repointing would collide with unique (business_id, phone_e164); merge by hand if that is really the intent."
  );
}

const phoneUnchanged = target.phone_e164 === TO_PHONE;
const emailUnchanged = EMAIL === undefined || (target.email ?? null) === EMAIL;
if (phoneUnchanged && emailUnchanged) {
  console.log(`[oneshot] business: ${biz.name} (${BUSINESS_ID})`);
  console.log(
    `[oneshot] roster row ${target.id} ("${target.name}") already holds ${TO_PHONE}` +
      (EMAIL ? ` and ${EMAIL}` : "") +
      ". Nothing to do."
  );
  process.exit(0);
}

// Solo-owner impact, reported because it changes how EVERY contact-scoped
// alert routes: the match is a literal E.164 comparison against the
// business's own numbers (pickImplicitContactOwner), so a repoint can flip
// the tenant between contact-owner paging and team-broadcast claim invites.
const { data: prefs } = await db
  .from("notification_preferences")
  .select("phone_number, alert_email")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
const ownerNumbers = [
  ...new Set(
    [biz.phone, (prefs as { phone_number?: string } | null)?.phone_number].filter(
      (p): p is string => typeof p === "string" && p.length > 0
    )
  )
];
const soloBefore = members.length === 1 && ownerNumbers.includes(target.phone_e164);
const soloAfter = members.length === 1 && ownerNumbers.includes(TO_PHONE);

console.log(`[oneshot] business: ${biz.name} (${BUSINESS_ID})`);
console.log("[oneshot] current roster:", JSON.stringify(members, null, 2));
console.log(
  "[oneshot] plan:",
  JSON.stringify(
    {
      member: `${target.id} ("${target.name}")`,
      phone: phoneUnchanged ? `unchanged (${TO_PHONE})` : `${target.phone_e164} -> ${TO_PHONE}`,
      email:
        EMAIL === undefined
          ? "unchanged (no --email)"
          : emailUnchanged
            ? `unchanged (${EMAIL})`
            : `${target.email ?? "null"} -> ${EMAIL}`,
      sms_reachability: `${smsReachability(target.phone_e164)} -> ${reachability}`,
      owner_numbers: ownerNumbers,
      solo_owner_match: `${soloBefore} -> ${soloAfter}`,
      routing_effect: soloAfter
        ? soloBefore
          ? "unchanged"
          : "contact-scoped alerts will page this member directly instead of team-broadcasting a claim invite"
        : soloBefore
          ? "contact-scoped alerts will switch FROM direct paging TO team-broadcast claim invites"
          : "unchanged (still not the solo owner)"
    },
    null,
    2
  )
);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const update: Record<string, string> = {};
if (!phoneUnchanged) update.phone_e164 = TO_PHONE;
if (EMAIL !== undefined && !emailUnchanged) update.email = EMAIL;

// `.select()` on the write: a PostgREST update matching zero rows returns no
// error, so the readback is what proves the change LANDED rather than that
// the statement was accepted.
const { data: written, error: updateErr } = await db
  .from("ai_flow_team_members")
  .update(update)
  .eq("id", target.id)
  .eq("business_id", BUSINESS_ID)
  .select("id, name, phone_e164, email, active");
if (updateErr) {
  fail(`roster update failed: ${updateErr.message}`);
}
if (!written || written.length !== 1) {
  fail(`roster update matched ${written?.length ?? 0} rows; expected exactly 1`);
}
const after = written[0] as { phone_e164: string; email: string | null };
if (after.phone_e164 !== TO_PHONE) {
  fail(`readback shows ${after.phone_e164}, expected ${TO_PHONE}`);
}
if (EMAIL !== undefined && (after.email ?? null) !== EMAIL) {
  fail(`readback shows email ${after.email ?? "null"}, expected ${EMAIL}`);
}

console.log("[oneshot] applied:", JSON.stringify(written[0], null, 2));

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    memberId: target.id,
    fromPhone: target.phone_e164,
    toPhone: TO_PHONE,
    emailSet: EMAIL !== undefined && !emailUnchanged,
    soloOwnerMatch: { before: soloBefore, after: soloAfter }
  }
});

console.log("[oneshot] done.");
