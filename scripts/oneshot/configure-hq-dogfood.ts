/**
 * configure-hq-dogfood.ts — one-shot: point the platform's own lead surfaces
 * at the HQ tenant and make owner alerting real (the "HQ works for New
 * Coworker" dogfooding plan, config half):
 *
 *   1. businesses.contact_form_sink → TRUE for HQ (public /contact
 *      submissions also enqueue webhook flow events; PR #773). Audit-logged
 *      to coworker_logs exactly like the admin card's route.
 *   2. businesses.aiflow_protect_staff_contacts → TRUE (the flow-test
 *      harness had turned it off; the default posture protects staff rows.
 *      flow-test-setup.ts re-disables it when the harness needs to).
 *   3. notification_preferences upsert: urgent SMS + email to Brian
 *      (+1 602 686 6672 / newcoworkerteam@gmail.com), and
 *      aiflow_failure_alerts ON so a dead HQ automation is never silent.
 *   4. business_telnyx_settings.forward_to_e164 → Brian's cell when empty
 *      (notify_owner texts this number; voice transfer_to_owner rings it).
 *
 * Usage:
 *   npx tsx scripts/oneshot/configure-hq-dogfood.ts          # dry-run
 *   npx tsx scripts/oneshot/configure-hq-dogfood.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const BRIAN_E164 = "+16026866672";
const BRIAN_EMAIL = "newcoworkerteam@gmail.com";

const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { getContactFormSinkBusinessId, setContactFormSink } = await import(
  "../../src/lib/db/contact-form-sink.ts"
);
const { setAiflowStaffProtection } = await import("../../src/lib/db/businesses.ts");
const {
  getNotificationPreferences,
  updateNotificationPreferences
} = await import("../../src/lib/db/notification-preferences.ts");
const { getBusinessTelnyxSettings, upsertBusinessTelnyxSettings } = await import(
  "../../src/lib/db/telnyx-routes.ts"
);
const { insertCoworkerLog } = await import("../../src/lib/db/logs.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- dry-run report
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("name, contact_form_sink, aiflow_protect_staff_contacts")
  .eq("id", HQ_BUSINESS_ID)
  .maybeSingle();
if (bizErr || !biz) {
  console.error("[config] HQ business not found — aborting", bizErr?.message ?? "");
  process.exit(1);
}
const currentSink = await getContactFormSinkBusinessId(db);
const prefs = await getNotificationPreferences(HQ_BUSINESS_ID, db);
const telnyx = await getBusinessTelnyxSettings(HQ_BUSINESS_ID, db);

console.log("[config] business:", biz);
console.log("[config] current contact-form sink business:", currentSink ?? "(none)");
console.log("[config] notification_preferences:", prefs
  ? {
      sms_urgent: prefs.sms_urgent,
      email_urgent: prefs.email_urgent,
      aiflow_failure_alerts: prefs.aiflow_failure_alerts,
      phone_number: prefs.phone_number,
      alert_email: prefs.alert_email
    }
  : "(missing — will create with defaults + Brian's contacts)");
console.log("[config] telnyx forward_to_e164:", telnyx?.forward_to_e164 ?? "(empty — will set)");

if (!APPLY) {
  console.log("[config] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// ---------------------------------------------------------------- 1. sink
await setContactFormSink(HQ_BUSINESS_ID, true, db);
try {
  await insertCoworkerLog({
    id: crypto.randomUUID(),
    business_id: HQ_BUSINESS_ID,
    task_type: "data_flow",
    status: "success",
    log_payload: {
      action: "contact_form_sink_updated",
      enabled: true,
      previousSinkBusinessId: currentSink,
      via: "oneshot configure-hq-dogfood"
    }
  });
} catch (e) {
  console.error("[config] sink audit log failed (non-fatal):", e);
}
console.log("[config] contact_form_sink = true");

// ---------------------------------------------------------------- 2. staff protection
await setAiflowStaffProtection(HQ_BUSINESS_ID, true, db);
console.log("[config] aiflow_protect_staff_contacts = true");

// ---------------------------------------------------------------- 3. owner alerts
await updateNotificationPreferences(
  HQ_BUSINESS_ID,
  {
    sms_urgent: true,
    email_urgent: true,
    aiflow_failure_alerts: true,
    phone_number: BRIAN_E164,
    alert_email: BRIAN_EMAIL
  },
  db
);
console.log("[config] notification_preferences: urgent SMS+email → Brian, aiflow failure alerts ON");

// ---------------------------------------------------------------- 4. forward number
if (!telnyx?.forward_to_e164) {
  await upsertBusinessTelnyxSettings(
    { businessId: HQ_BUSINESS_ID, forwardToE164: BRIAN_E164 },
    db
  );
  console.log("[config] forward_to_e164 =", BRIAN_E164);
} else {
  console.log("[config] forward_to_e164 already set — leaving", telnyx.forward_to_e164);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "configure-hq-dogfood.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    contactFormSink: true,
    staffProtection: true,
    urgentPhone: BRIAN_E164,
    alertEmail: BRIAN_EMAIL,
    forwardSet: !telnyx?.forward_to_e164
  }
});
console.log("[config] ledger recorded. Done.");
process.exit(0);
