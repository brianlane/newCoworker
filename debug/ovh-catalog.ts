/**
 * ovh-catalog.ts — read-only audit of the live OVHcloud public VPS catalog
 * against our VpsSize → plan-code mapping (src/lib/ovh/plans.ts).
 *
 * Runs against the OVHcloud US endpoint by default (the platform's account
 * entity — its catalog sells the `-ca` plan codes with the Beauharnois/BHS
 * datacenter). For each mapped size it reports whether the plan code exists
 * in the live catalog, its price, and whether BHS + an Ubuntu 24.04 OS
 * value are available for it. Run this BEFORE the first real OVH purchase
 * and after any OVH catalog/pricing announcement; fix mismatches via the
 * OVH_PLAN_CODE_KVM* env overrides (no deploy needed).
 *
 * Usage: npx tsx debug/ovh-catalog.ts
 * Env:   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY (repo-root .env)
 *        OVH_SUBSIDIARY (default US), OVH_API_BASE_URL (default ovh-us)
 */
import { loadEnv } from "./_shared.ts";
import { ovhClientFromEnv } from "../src/lib/ovh/client.ts";
import {
  ovhPlanCodeForSize,
  ovhSubsidiary,
  OVH_DATACENTER_CANADA,
  OVH_UBUNTU_IMAGE_MATCH
} from "../src/lib/ovh/plans.ts";
import { VPS_SIZES } from "../src/lib/vps/size.ts";

loadEnv();
const ovh = ovhClientFromEnv();

type CatalogPricing = {
  mode?: string;
  phase?: number;
  /** ISO duration ("P1M") on some endpoints, a numeric month count on others. */
  interval?: string | number;
  price?: number;
  capacities?: string[];
};

type CatalogPlan = {
  planCode: string;
  invoiceName?: string;
  product?: string;
  pricings?: CatalogPricing[];
  configurations?: Array<{ name?: string; values?: string[] }>;
};

type CatalogProduct = {
  name?: string;
  description?: string;
};

const subsidiary = ovhSubsidiary();
const catalog = (await ovh.getPublicVpsCatalog(subsidiary)) as {
  plans?: CatalogPlan[];
  products?: CatalogProduct[];
};
const plans = catalog.plans ?? [];
const products = new Map(
  (catalog.products ?? []).map((p) => [p.name ?? "", p.description ?? ""])
);
console.log(`ovhSubsidiary=${subsidiary} public VPS catalog: ${plans.length} plans\n`);

/**
 * Recurring monthly price for a plan. The US endpoint expresses it as
 * mode="default", capacities=["renew"], numeric interval 1; other
 * endpoints use interval "P1M". Accept both shapes.
 */
function monthlyPrice(plan: CatalogPlan): number | null {
  const hit = plan.pricings?.find(
    (p) =>
      p.mode === "default" &&
      ((p.capacities ?? []).includes("renew") || p.interval === "P1M") &&
      typeof p.price === "number" &&
      p.price > 0
  );
  return hit?.price ?? null;
}

let failures = 0;
for (const size of VPS_SIZES) {
  const code = ovhPlanCodeForSize(size);
  const plan = plans.find((p) => p.planCode === code);
  if (!plan) {
    failures += 1;
    console.log(`✗ ${size} → ${code}: NOT FOUND in live catalog`);
    const near = plans
      .map((p) => p.planCode)
      .filter((c) => c.startsWith(code.split("-").slice(0, 2).join("-")))
      .slice(0, 8);
    if (near.length) console.log(`    nearby codes: ${near.join(", ")}`);
    continue;
  }
  const dcConf = plan.configurations?.find((c) => c.name === "vps_datacenter");
  const osConf = plan.configurations?.find((c) => c.name === "vps_os");
  const hasBhs = (dcConf?.values ?? []).some(
    (v) => v.toLowerCase() === OVH_DATACENTER_CANADA.toLowerCase()
  );
  const ubuntu = (osConf?.values ?? []).filter((v) => /ubuntu/i.test(v));
  // Provisioning rebuilds with OVH_UBUNTU_IMAGE_MATCH specifically — a plan
  // that only ships older Ubuntu releases must FAIL the audit, not pass on
  // a generic /ubuntu/ match.
  const ubuntu2404 = ubuntu.filter((v) =>
    v.toLowerCase().includes(OVH_UBUNTU_IMAGE_MATCH.toLowerCase())
  );
  const monthly = monthlyPrice(plan);
  const specs = products.get(plan.product ?? "") || plan.invoiceName || "?";
  console.log(`✓ ${size} → ${code} (${specs})`);
  console.log(`    ${OVH_DATACENTER_CANADA} datacenter: ${hasBhs ? "available" : "MISSING"}`);
  console.log(
    `    ubuntu 24.04  : ${ubuntu2404.length ? ubuntu2404.join(", ") : `MISSING (ubuntu values: ${ubuntu.join(", ") || "<none>"})`}`
  );
  if (monthly != null) {
    // OVH public catalog prices are in 10^-8 currency units.
    console.log(`    monthly price : $${(monthly / 1e8).toFixed(2)} (excl. tax)`);
  }
  if (!hasBhs || ubuntu2404.length === 0) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} mapping problem(s) — fix via OVH_PLAN_CODE_KVM* env overrides.`);
  process.exit(1);
}
console.log("\nAll mapped plan codes verified against the live catalog.");
