/**
 * Build (or refresh) the internal "NCW Flow Test" tenant used to exercise
 * Truly Insurance's "Lead intake & follow-up (Privyr) (copy)" flow end to
 * end with a real phone — WITHOUT touching Truly's account (their flow
 * definition is read, never written).
 *
 * What it creates (idempotent; safe to re-run to refresh the flow copy):
 *   1. businesses row "NCW Flow Test (internal)" — tier standard, online,
 *      `phone` NULL (the tester's number must never match the owner-number
 *      set or their lead texts get the staff persona), staff-contact
 *      protection OFF (so update_contact tags land on the tester's row).
 *   2. ai_flow_team_members: the tester — the route_to_team roster target.
 *      Their lead texts still drive the flow via the staff wait-resume
 *      exception; "1"/"2" replies are offer-intercepted. NOTE the roster
 *      self-offer guard means offers NEVER go to the tester while they are
 *      also the lead — expect `owner_fallback` on route steps.
 *   3. A purchased 602 DID assigned to the tenant (inbound routing via
 *      telnyx_voice_routes), attached to the shared 10DLC campaign, with
 *      staff assistant replies disabled (no VPS/Rowboat exists to answer).
 *   4. A copy of Truly's CURRENT live flow definition, renamed, enabled,
 *      with ONE documented deviation: quiet hours widened to
 *      America/Phoenix 23:30–05:00 so evening test sends aren't deferred.
 *
 * Related: flow-test-kickoff.ts (enqueue a run), flow-test-reset.ts
 * (clear finished runs so the duplicate-lead guard treats the tester as a
 * fresh lead).
 *
 * Usage:
 *   tsx debug/flow-test-setup.ts          # dry-run
 *   tsx debug/flow-test-setup.ts --apply  # ⚠️ buys the DID on first run
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
export const FLOW_TEST_BUSINESS_ID = "f1047e50-0000-4000-8000-000000000001";
const TESTER_NAME = "Brian";
const TESTER_E164 = "+16026866672";
export const FLOW_TEST_FLOW_NAME = "Lead intake & follow-up (Privyr) (TEST COPY of Truly)";
const TRULY_FLOW_ID = "70be1676-cb42-4419-a414-bd3136e56be6";
const US_MESSAGING_PROFILE_ID = "40019da8-2a81-4673-a074-b8d05f69e01d";

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition } = await import("../src/lib/ai-flows/schema.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// Read-only snapshot of Truly's live definition, then the test-tenant
// quiet-hours deviation (documented above) applied to the COPY only.
const { data: trulyFlow, error: trulyErr } = await db
  .from("ai_flows")
  .select("definition")
  .eq("id", TRULY_FLOW_ID)
  .single();
if (trulyErr) throw new Error(`read Truly flow: ${trulyErr.message}`);
const defJson = JSON.stringify((trulyFlow as { definition: unknown }).definition)
  .replaceAll('"timezone":"America/New_York"', '"timezone":"America/Phoenix"')
  .replaceAll('"noSendAfter":"21:00"', '"noSendAfter":"23:30"')
  .replaceAll('"resumeAt":"08:00"', '"resumeAt":"05:00"')
  .replaceAll('"quietStart":"21:00"', '"quietStart":"23:30"')
  .replaceAll('"quietEnd":"08:30"', '"quietEnd":"05:00"');
const def = parseAiFlowDefinition(JSON.parse(defJson));

console.log("[setup] plan:", {
  businessId: FLOW_TEST_BUSINESS_ID,
  roster: `${TESTER_NAME} ${TESTER_E164}`,
  didSearch: "US / 602",
  flow: FLOW_TEST_FLOW_NAME,
  flowBytes: defJson.length
});

if (!APPLY) {
  console.log("[setup] dry run complete. Re-run with --apply to create (buys a DID on first run).");
  process.exit(0);
}

// 1. Business row.
{
  const { error } = await db.from("businesses").upsert(
    {
      id: FLOW_TEST_BUSINESS_ID,
      name: "NCW Flow Test (internal)",
      owner_email: "brianlane2@gmail.com",
      tier: "standard",
      status: "online",
      is_paused: false,
      timezone: "America/Phoenix",
      business_type: "insurance",
      owner_name: "NCW Internal",
      phone: null,
      aiflow_protect_staff_contacts: false
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`business upsert: ${error.message}`);
  console.log("[setup] business row ready");
}

// 2. Roster.
{
  const { data: existing } = await db
    .from("ai_flow_team_members")
    .select("id")
    .eq("business_id", FLOW_TEST_BUSINESS_ID)
    .eq("phone_e164", TESTER_E164)
    .maybeSingle();
  if (!existing) {
    const { error } = await db.from("ai_flow_team_members").insert({
      business_id: FLOW_TEST_BUSINESS_ID,
      name: TESTER_NAME,
      phone_e164: TESTER_E164,
      active: true
    });
    if (error) throw new Error(`roster insert: ${error.message}`);
  }
  console.log(`[setup] roster: ${TESTER_NAME} active`);
}

// 3. DID (bought once; later runs reuse it) + staff-reply suppression.
{
  const { getTelnyxVoiceRouteForBusiness } = await import("../src/lib/db/telnyx-routes.ts");
  const existingRoute = await getTelnyxVoiceRouteForBusiness(FLOW_TEST_BUSINESS_ID);
  if (existingRoute) {
    console.log(`[setup] DID already assigned: ${existingRoute.to_e164}`);
  } else {
    const { TelnyxNumbersClient } = await import("../src/lib/telnyx/numbers.ts");
    const { orderAndAssignDidForBusiness } = await import("../src/lib/telnyx/assign-did.ts");
    const telnyxNumbers = new TelnyxNumbersClient({ apiKey: process.env.TELNYX_API_KEY! });
    const result = await orderAndAssignDidForBusiness(
      {
        businessId: FLOW_TEST_BUSINESS_ID,
        platformDefaults: {
          connectionId: (process.env.TELNYX_CONNECTION_ID ?? "").trim(),
          messagingProfileId: US_MESSAGING_PROFILE_ID
        },
        search: { countryCode: "US", areaCode: "602" }
      },
      { telnyxNumbers }
    );
    console.log(`[setup] DID assigned: ${result.route.to_e164} (order ${result.orderId})`);
    const { attachBusinessDidToCampaign } = await import(
      "../src/lib/provisioning/tendlc-attach.ts"
    );
    const outcome = await attachBusinessDidToCampaign({
      businessId: FLOW_TEST_BUSINESS_ID,
      toE164: result.route.to_e164
    });
    console.log("[setup] 10DLC attach:", JSON.stringify(outcome));
  }
  const { error: staffErr } = await db
    .from("business_telnyx_settings")
    .update({ staff_sms_assistant_reply_enabled: false })
    .eq("business_id", FLOW_TEST_BUSINESS_ID);
  if (staffErr) throw new Error(`staff toggle: ${staffErr.message}`);
  console.log("[setup] staff assistant replies disabled");
}

// 4. Flow copy (insert or refresh from Truly's current definition).
{
  const { data: existing } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", FLOW_TEST_BUSINESS_ID)
    .eq("name", FLOW_TEST_FLOW_NAME)
    .maybeSingle();
  if (existing) {
    const { error } = await db
      .from("ai_flows")
      .update({ definition: def, enabled: true })
      .eq("id", (existing as { id: string }).id);
    if (error) throw new Error(`flow update: ${error.message}`);
    console.log(`[setup] flow refreshed (id=${(existing as { id: string }).id})`);
  } else {
    const { data, error } = await db
      .from("ai_flows")
      .insert({
        business_id: FLOW_TEST_BUSINESS_ID,
        name: FLOW_TEST_FLOW_NAME,
        enabled: true,
        definition: def
      })
      .select("id")
      .single();
    if (error) throw new Error(`flow insert: ${error.message}`);
    console.log(`[setup] flow created (id=${(data as { id: string }).id})`);
  }
}

console.log("[setup] done.");
