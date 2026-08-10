/**
 * apply-vfm-team.ts: put the Vantage Flow Media assignee on the KYP Ads
 * roster and turn on hands-free lead assignment.
 *
 * Two writes, both idempotent:
 *
 *   ai_flow_team_members    Upsert the VFM assignee (the teammate who runs
 *                           the VFM strategy calls) by (business, phone).
 *                           Email matters: without it, the email copy of a
 *                           redirected customer-reply page falls back to the
 *                           owner (contact_owner_target.ts, employee_no_email).
 *                           SKIPPED when no phone is supplied: a roster row
 *                           cannot exist without one (phone_e164 is NOT NULL),
 *                           and the VFM flow builder has an email-only mode
 *                           for that interim.
 *
 *   businesses.lead_auto_assign = true
 *                           The route_to_team pick IS the assignment: no
 *                           offer/claim handshake, the assignee gets an FYI
 *                           text and contact ownership is stamped at once
 *                           (Truly Issue 7 machinery). Verified before
 *                           writing: no existing KYP flow uses route_to_team,
 *                           so this changes nothing outside the VFM flow.
 *
 * Usage (ids/PII from argv or env, never hard-coded):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/apply-vfm-team.ts --business <uuid> \
 *     --name "<assignee name>" --email <assignee email> [--phone +1XXXXXXXXXX]
 *   ... --apply   # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = argValue("--business") ?? process.env.VFM_BUSINESS_ID;
const NAME = argValue("--name") ?? process.env.VFM_ASSIGNEE_NAME;
const EMAIL = (argValue("--email") ?? process.env.VFM_ASSIGNEE_EMAIL)?.trim().toLowerCase();
const PHONE = (argValue("--phone") ?? process.env.VFM_ASSIGNEE_PHONE)?.trim();

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set VFM_BUSINESS_ID)");
  process.exit(1);
}
if (!NAME || !EMAIL) {
  console.error("[oneshot] pass --name and --email (or VFM_ASSIGNEE_NAME / VFM_ASSIGNEE_EMAIL)");
  process.exit(1);
}
if (PHONE && !/^\+[1-9][0-9]{6,14}$/.test(PHONE)) {
  console.error(`[oneshot] --phone must be E.164 (+1XXXXXXXXXX), got: ${PHONE}`);
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// Guard: lead_auto_assign flips behavior for EVERY route_to_team step on the
// business. Refuse if any flow other than the VFM one already uses it, so a
// later KYP flow that adopted offer/claim semantics is never silently
// converted to hard assignment.
const { data: flows, error: flowErr } = await db
  .from("ai_flows")
  .select("id, name, definition")
  .eq("business_id", BUSINESS_ID);
if (flowErr) {
  console.error("[oneshot] flows read failed:", flowErr.message);
  process.exit(1);
}
const routeUsers = (flows ?? []).filter((f) =>
  JSON.stringify(f.definition ?? {}).includes('"route_to_team"')
);
const foreignRouteUsers = routeUsers.filter((f) => !/vantage flow media|vfm/i.test(f.name));
if (foreignRouteUsers.length > 0) {
  console.error(
    "[oneshot] refusing: these non-VFM flows already use route_to_team and would switch to hard assignment:",
    foreignRouteUsers.map((f) => f.name)
  );
  process.exit(1);
}

const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, lead_auto_assign")
  .eq("id", BUSINESS_ID)
  .maybeSingle();
if (bizErr || !biz) {
  console.error("[oneshot] business not found:", bizErr?.message ?? BUSINESS_ID);
  process.exit(1);
}

const { data: existing, error: rosterErr } = await db
  .from("ai_flow_team_members")
  .select("id, name, phone_e164, email, active")
  .eq("business_id", BUSINESS_ID);
if (rosterErr) {
  console.error("[oneshot] roster read failed:", rosterErr.message);
  process.exit(1);
}

const byPhone = PHONE ? (existing ?? []).find((m) => m.phone_e164 === PHONE) : undefined;
const plan = {
  roster: !PHONE
    ? "skip (no --phone; VFM flow runs in email-only mode until re-applied with one)"
    : byPhone
      ? `update existing member ${byPhone.id} (name/email/active)`
      : "insert new member",
  lead_auto_assign: biz.lead_auto_assign === true ? "already true, no change" : "set true"
};
console.log(`[oneshot] business: ${biz.name} (${BUSINESS_ID})`);
console.log("[oneshot] current roster:", JSON.stringify(existing, null, 2));
console.log("[oneshot] plan:", JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

let memberId: string | null = null;
if (PHONE) {
  if (byPhone) {
    const { error } = await db
      .from("ai_flow_team_members")
      .update({ name: NAME, email: EMAIL, active: true })
      .eq("id", byPhone.id);
    if (error) {
      console.error("[oneshot] roster update failed:", error.message);
      process.exit(1);
    }
    memberId = byPhone.id;
  } else {
    const { data, error } = await db
      .from("ai_flow_team_members")
      .insert({
        business_id: BUSINESS_ID,
        name: NAME,
        phone_e164: PHONE,
        email: EMAIL,
        active: true
      })
      .select("id")
      .single();
    if (error) {
      console.error("[oneshot] roster insert failed:", error.message);
      process.exit(1);
    }
    memberId = data.id;
  }
  console.log(`[oneshot] roster member ready: ${memberId}`);
}

if (biz.lead_auto_assign !== true) {
  const { error } = await db
    .from("businesses")
    .update({ lead_auto_assign: true })
    .eq("id", BUSINESS_ID);
  if (error) {
    console.error("[oneshot] lead_auto_assign update failed:", error.message);
    process.exit(1);
  }
  console.log("[oneshot] lead_auto_assign set to true.");
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    roster_member_id: memberId,
    roster_skipped_no_phone: !PHONE,
    lead_auto_assign: true
  }
});

console.log("[oneshot] applied.");
