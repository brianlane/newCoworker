/**
 * Prepare the "New Coworker (HQ, internal)" tenant to exercise Truly
 * Insurance's "Lead intake & follow-up (Privyr) (copy)" flow end to end with
 * a real phone — WITHOUT touching Truly's account (their flow definition is
 * read, never written).
 *
 * The HQ tenant (onboarded Jul 16 2026 via scripts/oneshot/onboard-hq-tenant.ts,
 * srv1806097, DID +1 602 313 1823) replaced the throwaway "NCW Flow Test"
 * tenant as the internal smoke/e2e target — one internal tenant, no extra
 * boxes or DIDs. This script therefore never creates a business or buys a
 * number: it asserts the HQ tenant + DID exist and layers the harness on top.
 *
 * What it ensures (idempotent; safe to re-run to refresh the flow copy):
 *   1. `aiflow_protect_staff_contacts` OFF on the HQ business (so
 *      update_contact tags land on the tester's row; the tester is both the
 *      roster member and the lead). The HQ business row is otherwise never
 *      written — its `phone` must stay NULL / not equal the tester's number,
 *      or the tester's lead texts get the staff persona.
 *   2. ai_flow_team_members: the tester — the route_to_team roster target.
 *      Their lead texts still drive the flow via the staff wait-resume
 *      exception; "1"/"2" replies are offer-intercepted. NOTE the roster
 *      self-offer guard means offers NEVER go to the tester while they are
 *      also the lead — expect `owner_fallback` on route steps.
 *   3. Staff assistant replies disabled on the HQ Telnyx settings, so the
 *      tester's inbound texts feed the flow engine instead of getting a
 *      staff-assistant reply from the (live) HQ box.
 *   4. A copy of Truly's CURRENT live flow definition, renamed, enabled,
 *      with ONE documented deviation: quiet hours widened to
 *      America/Phoenix 23:30–05:00 so evening test sends aren't deferred.
 *
 * Related: flow-test-kickoff.ts (enqueue a run), flow-test-reset.ts
 * (clear the TEST flow's finished runs so the duplicate-lead guard treats
 * the tester as a fresh lead).
 *
 * Usage:
 *   tsx debug/flow-test-setup.ts          # dry-run
 *   tsx debug/flow-test-setup.ts --apply
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
/** New Coworker (HQ, internal) — the single internal smoke/e2e tenant. */
export const FLOW_TEST_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const TESTER_NAME = "Brian";
const TESTER_E164 = "+16026866672";
export const FLOW_TEST_FLOW_NAME = "Lead intake & follow-up (Privyr) (TEST COPY of Truly)";
const TRULY_FLOW_ID = "70be1676-cb42-4419-a414-bd3136e56be6";

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
  flow: FLOW_TEST_FLOW_NAME,
  flowBytes: defJson.length
});

if (!APPLY) {
  console.log("[setup] dry run complete. Re-run with --apply to prepare the HQ tenant.");
  process.exit(0);
}

// 1. HQ business must already exist (onboard-hq-tenant.ts owns its creation);
//    this harness only flips the staff-contact-protection flag it needs.
{
  const { data: biz, error } = await db
    .from("businesses")
    .select("id, name, phone")
    .eq("id", FLOW_TEST_BUSINESS_ID)
    .maybeSingle();
  if (error) throw new Error(`business read: ${error.message}`);
  if (!biz) {
    throw new Error(
      `HQ business ${FLOW_TEST_BUSINESS_ID} not found — run scripts/oneshot/onboard-hq-tenant.ts first`
    );
  }
  const phone = (biz as { phone: string | null }).phone;
  if (phone && phone.replace(/[^\d]/g, "").endsWith(TESTER_E164.replace(/[^\d]/g, "").slice(-10))) {
    throw new Error(
      "HQ business phone equals the tester's number — lead texts would get the staff persona"
    );
  }
  const { error: flagErr } = await db
    .from("businesses")
    .update({ aiflow_protect_staff_contacts: false })
    .eq("id", FLOW_TEST_BUSINESS_ID);
  if (flagErr) throw new Error(`staff-contact protection flag: ${flagErr.message}`);
  console.log(`[setup] business ready: ${(biz as { name: string }).name}`);
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

// 3. DID: the HQ tenant already owns +1 602 313 1823 (homepage demo line) —
//    never buy a number here; just assert routing exists, then suppress
//    staff-assistant replies so the tester's texts feed the flow engine.
{
  const { getTelnyxVoiceRouteForBusiness } = await import("../src/lib/db/telnyx-routes.ts");
  const existingRoute = await getTelnyxVoiceRouteForBusiness(FLOW_TEST_BUSINESS_ID);
  if (!existingRoute) {
    throw new Error(
      "HQ tenant has no DID route — expected +16023131823 (see onboard-hq-tenant.ts)"
    );
  }
  console.log(`[setup] DID: ${existingRoute.to_e164}`);
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
