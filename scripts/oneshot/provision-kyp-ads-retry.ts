/**
 * provision-kyp-ads-retry.ts — one-shot: re-run provisioning for the KYP Ads
 * tenant (056034a7-e84c-444d-8d15-747eeb1fa899, signed up Jul 14 2026) whose
 * Stripe-webhook-triggered provisioning died silently at 5%: the webhook
 * function's 300s maxDuration tore the orchestrator down mid-adopt (VM
 * 1800985 recreate takes minutes). Same failure mode + same recovery as
 * provision-truly-insurance-519.ts, minus the DID override — this one uses
 * the platform-default DID search.
 *
 * Precondition (applied manually before the run): the vps_inventory row for
 * VM 1800985 was reset from the dead attempt's claim (assigned →
 * available), so the adopt-first path re-claims the same box instead of
 * purchasing a new one.
 *
 * Usage:
 *   npx tsx scripts/oneshot/provision-kyp-ads-retry.ts          # dry-run summary
 *   npx tsx scripts/oneshot/provision-kyp-ads-retry.ts --apply  # ⚠️ adopts VM + purchases DID
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";

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

// Refuse when the business is online OR already has a VPS reference — same
// double-provision guard as the Truly one-shot.
if (business.status === "online" || business.hostinger_vps_id) {
  console.error(
    `[oneshot] refusing to provision: status=${business.status}, ` +
      `hostinger_vps_id=${business.hostinger_vps_id ?? "null"} — use the admin re-provision flow instead`
  );
  process.exit(1);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to provision (adopts VM + purchases DID).");
  process.exit(0);
}

const { orchestrateProvisioning } = await import("../../src/lib/provisioning/orchestrate.ts");

console.log("[oneshot] starting orchestrator (this takes ~10 minutes)...");
const result = await orchestrateProvisioning({
  businessId: BUSINESS_ID,
  tier: business.tier,
  vpsSize: business.vps_size ?? null,
  billingPeriod: subscription?.billing_period ?? null,
  ownerEmail: business.owner_email
});
console.log("[oneshot] orchestrator result:", JSON.stringify(result, null, 2));
