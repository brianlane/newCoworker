/**
 * assign-kyp-ads-did-438.ts — one-shot: buy + assign a Montreal-overlay
 * (438) DID for KYP Ads (056034a7-e84c-444d-8d15-747eeb1fa899), whose
 * signup provisioning could not auto-assign a number: the owner's 514 NPA
 * had no Telnyx inventory and the API's 400/10031 response aborted the
 * search cascade (fixed properly in the provisioning-resilience PR).
 *
 * Canadian tenant → the (US+CA) messaging profile, NOT the US default:
 * without CA carrier whitelisting every outbound SMS fails with Telnyx
 * 40309 (the Truly Insurance incident). 10DLC attach is skipped — that is
 * US A2P registration and does not apply to a CA number.
 *
 * Usage:
 *   npx tsx scripts/oneshot/assign-kyp-ads-did-438.ts          # dry-run
 *   npx tsx scripts/oneshot/assign-kyp-ads-did-438.ts --apply  # ⚠️ buys the number
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";
// "New Coworker SMS (US+CA)" — the platform-wide Canadian-capable profile.
const CA_MESSAGING_PROFILE_ID = "40019f47-a642-4b58-9f0e-b456600cc671";
const SEARCH = { countryCode: "CA", areaCode: "438" } as const;

const { getBusiness } = await import("../../src/lib/db/businesses.ts");
const { getTelnyxVoiceRouteForBusiness } = await import("../../src/lib/db/telnyx-routes.ts");

const business = await getBusiness(BUSINESS_ID);
if (!business) {
  console.error(`Business ${BUSINESS_ID} not found`);
  process.exit(1);
}
const existingRoute = await getTelnyxVoiceRouteForBusiness(BUSINESS_ID);
if (existingRoute) {
  console.error(`[oneshot] refusing: DID already assigned (${existingRoute.to_e164})`);
  process.exit(1);
}

const connectionId = (process.env.TELNYX_CONNECTION_ID ?? "").trim();
if (!connectionId || !(process.env.TELNYX_API_KEY ?? "").trim()) {
  console.error("[oneshot] TELNYX_CONNECTION_ID / TELNYX_API_KEY missing from env");
  process.exit(1);
}
const bridgeOrigin = `wss://voice-${BUSINESS_ID}.newcoworker.com`;

console.log("[oneshot] plan:", {
  business: business.name,
  search: SEARCH,
  messagingProfileId: CA_MESSAGING_PROFILE_ID,
  connectionId: `${connectionId.slice(0, 8)}…`,
  bridgeOrigin
});

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to buy + assign the DID.");
  process.exit(0);
}

const { TelnyxNumbersClient } = await import("../../src/lib/telnyx/numbers.ts");
const { orderAndAssignDidForBusiness } = await import("../../src/lib/telnyx/assign-did.ts");

const telnyxNumbers = new TelnyxNumbersClient({ apiKey: process.env.TELNYX_API_KEY! });
const result = await orderAndAssignDidForBusiness(
  {
    businessId: BUSINESS_ID,
    platformDefaults: {
      connectionId,
      messagingProfileId: CA_MESSAGING_PROFILE_ID,
      bridgeMediaWssOrigin: bridgeOrigin
    },
    search: SEARCH
  },
  { telnyxNumbers }
);
console.log("[oneshot] assigned:", {
  did: result.route.to_e164,
  orderId: result.orderId,
  settingsProfile: result.settings.telnyx_messaging_profile_id
});
