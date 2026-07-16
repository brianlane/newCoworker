/**
 * onboard-hq-tenant.ts — one-shot: onboard "New Coworker (HQ, internal)" as a
 * real tenant on the reserved KVM1 (srv1806097) with the +1 (602) 313-1823
 * DID, so the homepage demo voice line, site webchat, and SMS all run through
 * the standard tenant stack. No Stripe: the subscription row is synthetic
 * (active, 24-month period bounds, no stripe id — the voice reserve gate only
 * needs cached bounds, and included quotas still reset monthly via
 * deriveMonthlyQuotaWindow).
 *
 * What --apply does (idempotent, in order):
 *   1. Create the HQ business (tier standard, vps_size kvm1) if missing.
 *   2. Create the synthetic active subscription with period bounds if missing.
 *   3. Seed business_configs from the Residency Pilot webchat vault (same
 *      persona the site webchat uses today) + HQ identity + demo-line memory.
 *   4. Point vps_inventory srv1806097 at the HQ business (it was reserved out
 *      of the adoption pool on Jul 16 2026; auto-renew is already ON).
 *   5. Move the DID: business_telnyx_settings (messaging profile, connection,
 *      from-number, registered 10DLC campaign) from NCW Flow Test → HQ, clear
 *      the flow-test from-number, and upsert the telnyx_voice_routes row to
 *      HQ with the per-tenant bridge origin.
 *   6. Run the standard provisioning orchestrator: adopt srv1806097 (the pool
 *      claim resolves the pre-assigned box), bootstrap, per-tenant tunnel +
 *      gateway token, full deploy with GEMINI_LIVE_SESSION_MAX_MS=300000 (the
 *      5-minute demo call cap) and voice transcription on. Purchasing a new
 *      box is hard-refused — adopt-only.
 *
 * Usage:
 *   npx tsx scripts/oneshot/onboard-hq-tenant.ts          # dry-run summary
 *   npx tsx scripts/oneshot/onboard-hq-tenant.ts --apply  # ⚠️ adopts + deploys
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

// The demo call cap (5 min) + transcript capture for demo QA. Set BEFORE the
// orchestrator import chain reads process.env at deploy-command build time.
process.env.GEMINI_LIVE_SESSION_MAX_MS = process.env.GEMINI_LIVE_SESSION_MAX_MS ?? "300000";
process.env.VOICE_TRANSCRIPTION_ENABLED = process.env.VOICE_TRANSCRIPTION_ENABLED ?? "true";

const APPLY = process.argv.includes("--apply");

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const HQ_NAME = "New Coworker (HQ, internal)";
const HQ_OWNER_EMAIL = "newcoworkerteam@gmail.com";
const HQ_TIMEZONE = "America/Phoenix";
const HQ_VM_ID = 1806097;
const HQ_DID = "+16023131823";
const FLOW_TEST_BUSINESS_ID = "f1047e50-0000-4000-8000-000000000001";
const WEBCHAT_VAULT_SOURCE_BUSINESS_ID = "7e2b9d4a-1f3c-4e5d-9a6b-8c7d0e1f2a3b"; // Residency Pilot
const BRIDGE_MEDIA_WSS_ORIGIN = `wss://voice-${HQ_BUSINESS_ID}.newcoworker.com`;

const HQ_IDENTITY_MD = `# identity.md

Business Name: New Coworker
Owner Name: New Coworker Team
Primary Market: Small businesses across the US and Canada
Key Service Promise: A 24/7 AI employee that answers calls, texts, and emails, books appointments, and never forgets a customer.
`;

const HQ_DEMO_MEMORY_APPENDIX = `
## Demo line (authoritative — this phone number is New Coworker's own demo)
- You ARE the product: callers on this line are prospects trying New Coworker's AI coworker for themselves. Be the best possible demonstration — warm, competent, and natural.
- Answer questions about New Coworker (features, pricing, setup, security) using the facts above and the website knowledge.
- Demo calls are intentionally brief (about five minutes). Showcase what matters, don't pad. If the caller wants to go deeper, invite them to start a plan at newcoworker.com or leave their contact details for the team to follow up.
- Feel free to demonstrate capabilities when asked (e.g. capture their details, send a follow-up text) — that IS the demo.
`;

const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { getBusiness, createBusiness } = await import("../../src/lib/db/businesses.ts");
const { getSubscription, createSubscription } = await import("../../src/lib/db/subscriptions.ts");
const { getBusinessConfig, upsertBusinessConfig } = await import("../../src/lib/db/configs.ts");
const { getBusinessTelnyxSettings, upsertBusinessTelnyxSettings, upsertTelnyxVoiceRoute } =
  await import("../../src/lib/db/telnyx-routes.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- dry-run report
const existingBusiness = await getBusiness(HQ_BUSINESS_ID).catch(() => null);
const existingSub = existingBusiness ? await getSubscription(HQ_BUSINESS_ID) : null;
const sourceConfig = await getBusinessConfig(WEBCHAT_VAULT_SOURCE_BUSINESS_ID);
const flowTestTelnyx = await getBusinessTelnyxSettings(FLOW_TEST_BUSINESS_ID);
const { data: inventoryRow } = await db
  .from("vps_inventory")
  .select("vm_id, state, assigned_business_id, hostinger_billing_subscription_id, never_renew")
  .eq("vm_id", HQ_VM_ID)
  .maybeSingle();
const { data: routeRow } = await db
  .from("telnyx_voice_routes")
  .select("to_e164, business_id, media_wss_origin")
  .eq("to_e164", HQ_DID)
  .maybeSingle();

console.log("[oneshot] HQ business:", existingBusiness
  ? { exists: true, status: existingBusiness.status, vps: existingBusiness.hostinger_vps_id }
  : { exists: false, willCreate: { id: HQ_BUSINESS_ID, name: HQ_NAME, tier: "standard", vpsSize: "kvm1" } });
console.log("[oneshot] subscription:", existingSub
  ? { exists: true, status: existingSub.status, periodEnd: existingSub.stripe_current_period_end }
  : { exists: false, willCreate: "synthetic active, period now → +24mo, no stripe id" });
console.log("[oneshot] vault source (Residency Pilot):", {
  soul: sourceConfig?.soul_md?.length ?? 0,
  memory: sourceConfig?.memory_md?.length ?? 0,
  website: sourceConfig?.website_md?.length ?? 0
});
console.log("[oneshot] vps_inventory:", inventoryRow);
console.log("[oneshot] DID route:", routeRow, "→ will point at", {
  businessId: HQ_BUSINESS_ID,
  mediaWssOrigin: BRIDGE_MEDIA_WSS_ORIGIN
});
console.log("[oneshot] flow-test telnyx settings:", flowTestTelnyx && {
  profile: flowTestTelnyx.telnyx_messaging_profile_id,
  from: flowTestTelnyx.telnyx_sms_from_e164,
  connection: flowTestTelnyx.telnyx_connection_id,
  campaign: flowTestTelnyx.telnyx_messaging_campaign_id,
  campaignStatus: flowTestTelnyx.telnyx_messaging_campaign_status
});
console.log("[oneshot] deploy env:", {
  GEMINI_LIVE_SESSION_MAX_MS: process.env.GEMINI_LIVE_SESSION_MAX_MS,
  VOICE_TRANSCRIPTION_ENABLED: process.env.VOICE_TRANSCRIPTION_ENABLED
});

if (!sourceConfig) {
  console.error("[oneshot] Residency Pilot vault source config missing — aborting");
  process.exit(1);
}
if (!flowTestTelnyx?.telnyx_messaging_profile_id || !flowTestTelnyx?.telnyx_connection_id) {
  console.error("[oneshot] flow-test Telnyx settings incomplete — cannot move the DID wiring");
  process.exit(1);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to onboard (adopts srv1806097 + deploys).");
  process.exit(0);
}

// ---------------------------------------------------------------- 1. business
if (!existingBusiness) {
  await createBusiness({
    id: HQ_BUSINESS_ID,
    name: HQ_NAME,
    ownerEmail: HQ_OWNER_EMAIL,
    tier: "standard",
    businessType: "other",
    ownerName: "New Coworker Team",
    websiteUrl: "https://www.newcoworker.com",
    timezone: HQ_TIMEZONE,
    vpsSize: "kvm1"
  });
  console.log("[oneshot] business created");
} else {
  console.log("[oneshot] business exists — skipping create");
}

// ---------------------------------------------------------------- 2. subscription
if (!existingSub) {
  const now = new Date();
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 24);
  await createSubscription({
    id: crypto.randomUUID(),
    business_id: HQ_BUSINESS_ID,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    tier: "standard",
    status: "active",
    billing_period: null,
    stripe_current_period_start: now.toISOString(),
    stripe_current_period_end: end.toISOString(),
    stripe_subscription_cached_at: now.toISOString()
  });
  console.log("[oneshot] synthetic subscription created (period ends", end.toISOString(), ")");
} else {
  console.log("[oneshot] subscription exists — skipping create");
}

// ---------------------------------------------------------------- 3. vault
const existingHqConfig = await getBusinessConfig(HQ_BUSINESS_ID);
if (!existingHqConfig?.soul_md) {
  await upsertBusinessConfig({
    business_id: HQ_BUSINESS_ID,
    soul_md: sourceConfig.soul_md,
    identity_md: HQ_IDENTITY_MD,
    memory_md: `${sourceConfig.memory_md.trimEnd()}\n${HQ_DEMO_MEMORY_APPENDIX}`,
    website_md: sourceConfig.website_md
  });
  console.log("[oneshot] vault seeded from webchat persona + demo appendix");
} else {
  console.log("[oneshot] business_configs already populated — skipping vault seed");
}

// ---------------------------------------------------------------- 4. inventory
// The row was reserved (state=assigned, no business) on Jul 16 2026; point it
// at the HQ business so the orchestrator's pool claim resolves exactly this
// box (claimAvailableVps returns a box already assigned to the business).
{
  const { error } = await db
    .from("vps_inventory")
    .update({
      assigned_business_id: HQ_BUSINESS_ID,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("vm_id", HQ_VM_ID);
  if (error) throw new Error(`vps_inventory update: ${error.message}`);
  console.log("[oneshot] vps_inventory srv1806097 assigned to HQ");
}

// ---------------------------------------------------------------- 5. DID move
await upsertBusinessTelnyxSettings({
  businessId: HQ_BUSINESS_ID,
  telnyxMessagingProfileId: flowTestTelnyx.telnyx_messaging_profile_id,
  telnyxSmsFromE164: HQ_DID,
  telnyxConnectionId: flowTestTelnyx.telnyx_connection_id,
  bridgeMediaWssOrigin: BRIDGE_MEDIA_WSS_ORIGIN
});
// The DID is already attached to the registered 10DLC campaign at Telnyx —
// copy the campaign bookkeeping so the tendlc retry cron doesn't re-attach.
{
  const { error } = await db
    .from("business_telnyx_settings")
    .update({
      telnyx_tcr_brand_id: flowTestTelnyx.telnyx_tcr_brand_id,
      telnyx_tcr_campaign_id: flowTestTelnyx.telnyx_tcr_campaign_id,
      telnyx_messaging_campaign_id: flowTestTelnyx.telnyx_messaging_campaign_id,
      telnyx_messaging_campaign_status: flowTestTelnyx.telnyx_messaging_campaign_status,
      telnyx_messaging_campaign_attached_at: flowTestTelnyx.telnyx_messaging_campaign_attached_at,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", HQ_BUSINESS_ID);
  if (error) throw new Error(`campaign bookkeeping copy: ${error.message}`);
}
await upsertBusinessTelnyxSettings({
  businessId: FLOW_TEST_BUSINESS_ID,
  telnyxSmsFromE164: null
});
await upsertTelnyxVoiceRoute({
  toE164: HQ_DID,
  businessId: HQ_BUSINESS_ID,
  mediaWssOrigin: BRIDGE_MEDIA_WSS_ORIGIN
});
console.log("[oneshot] DID moved: settings + voice route now on HQ, flow-test from-number cleared");

// ---------------------------------------------------------------- 6. provision
const { orchestrateProvisioning } = await import("../../src/lib/provisioning/orchestrate.ts");

const result = await orchestrateProvisioning(
  {
    businessId: HQ_BUSINESS_ID,
    tier: "standard",
    vpsSize: "kvm1",
    billingPeriod: null,
    ownerEmail: HQ_OWNER_EMAIL
  },
  {
    // Adopt-only: the reserved srv1806097 must be the box. If the adopt path
    // fails we want a loud abort, never a silent Hostinger purchase.
    vpsProvisioner: async () => {
      throw new Error(
        "onboard-hq-tenant: refusing to PURCHASE a box — this onboarding is adopt-only (srv1806097). " +
          "If the adopt failed, fix vps_inventory / the VM and re-run."
      );
    },
    orphanReconciler: null,
    // The DID already exists and is routed above; never order a number.
    didProvisioner: null
  }
);

console.log("[oneshot] provisioning complete:", result);

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "onboard-hq-tenant.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    vmId: HQ_VM_ID,
    did: HQ_DID,
    bridgeMediaWssOrigin: BRIDGE_MEDIA_WSS_ORIGIN,
    geminiLiveSessionMaxMs: process.env.GEMINI_LIVE_SESSION_MAX_MS,
    movedDidFromBusinessId: FLOW_TEST_BUSINESS_ID,
    vaultSourceBusinessId: WEBCHAT_VAULT_SOURCE_BUSINESS_ID
  }
});
console.log("[oneshot] ledger recorded. Done.");
process.exit(0);
