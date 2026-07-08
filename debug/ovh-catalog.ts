/**
 * ovh-catalog.ts — read-only audit of the live `ovh-ca` public VPS catalog
 * against our VpsSize → plan-code mapping (src/lib/ovh/plans.ts).
 *
 * For each mapped size it reports whether the plan code exists in the live
 * catalog, its price, and whether the Beauharnois (bhs) datacenter + an
 * Ubuntu 24.04 OS value are available for it. Run this BEFORE the first
 * real OVH purchase and after any OVH catalog/pricing announcement; fix
 * mismatches via the OVH_PLAN_CODE_KVM* env overrides (no deploy needed).
 *
 * Usage: npx tsx debug/ovh-catalog.ts
 * Env:   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY (repo-root .env)
 */
import { loadEnv } from "./_shared.ts";
import { ovhClientFromEnv } from "../src/lib/ovh/client.ts";
import { ovhPlanCodeForSize, OVH_DATACENTER_CANADA } from "../src/lib/ovh/plans.ts";
import { VPS_SIZES } from "../src/lib/vps/size.ts";

loadEnv();
const ovh = ovhClientFromEnv();

type CatalogPlan = {
  planCode: string;
  invoiceName?: string;
  pricings?: Array<{
    mode?: string;
    phase?: number;
    interval?: string;
    price?: number;
    tax?: number;
    capacities?: string[];
  }>;
  configurations?: Array<{ name?: string; values?: string[] }>;
};

const catalog = (await ovh.getPublicVpsCatalog("CA")) as { plans?: CatalogPlan[] };
const plans = catalog.plans ?? [];
console.log(`ovh-ca public VPS catalog: ${plans.length} plans\n`);

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
  const hasBhs = (dcConf?.values ?? []).some((v) => v.toLowerCase().includes(OVH_DATACENTER_CANADA));
  const ubuntu = (osConf?.values ?? []).filter((v) => /ubuntu/i.test(v));
  const monthly = plan.pricings?.find(
    (p) => p.mode === "default" && (p.interval === "P1M" || p.interval === undefined)
  );
  console.log(`✓ ${size} → ${code} (${plan.invoiceName ?? "?"})`);
  console.log(`    bhs datacenter: ${hasBhs ? "available" : "MISSING"}`);
  console.log(`    ubuntu images : ${ubuntu.length ? ubuntu.join(", ") : "MISSING"}`);
  if (monthly?.price != null) {
    // OVH public catalog prices are in 10^-8 currency units.
    console.log(`    monthly price : $${(monthly.price / 1e8).toFixed(2)} CAD (excl. tax)`);
  }
  if (!hasBhs || ubuntu.length === 0) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} mapping problem(s) — fix via OVH_PLAN_CODE_KVM* env overrides.`);
  process.exit(1);
}
console.log("\nAll mapped plan codes verified against the live catalog.");
