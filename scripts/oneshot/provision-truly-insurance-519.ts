/**
 * provision-truly-insurance-519.ts — one-shot: provision the Truly Insurance
 * tenant (690f85c0-ee16-4ee5-bde5-5829df2e5410, signed up Jul 8 2026) whose
 * Stripe-webhook-triggered provisioning died at 5% with
 * "Hostinger /api/vps/v1/post-install-scripts → HTTP 0 (timed out after
 * 30000ms)".
 *
 * Runs the standard orchestrator locally with ONE override: the DID
 * provisioner is pinned to a Canadian 519 (Ontario) number for THIS tenant
 * only — the owner is in Ontario (416 phone), and 519 inventory only exists
 * under countryCode=CA, which the env-default US/602 search would never find.
 * Platform defaults (TELNYX_DEFAULT_*) are untouched.
 *
 * Usage:
 *   npx tsx scripts/oneshot/provision-truly-insurance-519.ts          # dry-run summary
 *   npx tsx scripts/oneshot/provision-truly-insurance-519.ts --apply  # ⚠️ purchases VPS + DID
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410";
const DID_SEARCH = { countryCode: "CA", areaCode: "519" } as const;

const { getBusiness } = await import("../../src/lib/db/businesses.ts");
const { getSubscription } = await import("../../src/lib/db/subscriptions.ts");

const business = await getBusiness(BUSINESS_ID);
if (!business) {
  console.error(`Business ${BUSINESS_ID} not found`);
  process.exit(1);
}
const subscription = await getSubscription(BUSINESS_ID);

console.log("[oneshot] business:", {
  id: business.id,
  name: business.name,
  tier: business.tier,
  status: business.status,
  hostinger_vps_id: business.hostinger_vps_id,
  billing_period: subscription?.billing_period ?? null
});
console.log("[oneshot] DID search override:", DID_SEARCH);

if (business.status === "online" && business.hostinger_vps_id) {
  console.error("[oneshot] business already online with a VPS — refusing to re-provision");
  process.exit(1);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to provision (purchases VPS + DID).");
  process.exit(0);
}

const { orchestrateProvisioning } = await import("../../src/lib/provisioning/orchestrate.ts");
const { orderAndAssignDidForBusiness } = await import("../../src/lib/telnyx/assign-did.ts");
const { TelnyxNumbersClient } = await import("../../src/lib/telnyx/numbers.ts");

const result = await orchestrateProvisioning(
  {
    businessId: BUSINESS_ID,
    tier: business.tier,
    vpsSize: business.vps_size ?? null,
    billingPeriod: subscription?.billing_period ?? null,
    ownerEmail: business.owner_email
  },
  {
    // Same flow as defaultDidProvisioner, but the search is pinned to CA/519
    // for this run. The orchestrator's own search args (owner-phone-derived
    // 416, or the US/602 env defaults) are intentionally ignored.
    didProvisioner: async ({ businessId, platformDefaults }) => {
      const apiKey = process.env.TELNYX_API_KEY ?? "";
      if (!apiKey) throw new Error("TELNYX_API_KEY missing — cannot auto-purchase DID");
      const telnyxNumbers = new TelnyxNumbersClient({ apiKey });
      const didResult = await orderAndAssignDidForBusiness(
        { businessId, platformDefaults, search: DID_SEARCH },
        { telnyxNumbers }
      );
      console.log("[oneshot] DID ordered + assigned:", didResult.route.to_e164, "order:", didResult.orderId);
      return { toE164: didResult.route.to_e164 };
    }
  }
);

console.log("[oneshot] provisioning complete:", result);
process.exit(0);
