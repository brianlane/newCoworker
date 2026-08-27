/**
 * Do the live Stripe price objects charge what the app quotes?
 *
 * Every dollar the app QUOTES (the term-nudge email, PlanCard, the order
 * summary, the comparison table) comes from the hardcoded table in
 * src/lib/plans/tier.ts. Every dollar actually CHARGED comes from whatever
 * price object the STRIPE_<TIER>_<24MO|12MO|1MO>[_RENEWAL]_PRICE_ID env vars
 * name. Nothing reconciled the two: audit finding M1 (the term-end email
 * quoting a rate 48% high) shipped its fix by pinning code against code,
 * which cannot catch a quoted number disagreeing with the number Stripe
 * bills. This probe is M1's falsification test, runnable.
 *
 * Also asserts the two monthly INTRO coupons are `amount_off` for exactly
 * (renewal - contract) cents. The intro-coupon dilution across pack lines is
 * safe ONLY because the coupon is amount_off; a percent_off swap would
 * silently discount packs too (audit, "Verified clean in the billing
 * cluster"). This check replaces the "add a comment so nobody switches it"
 * follow-up with something that actually fails.
 *
 * Read-only: `prices.retrieve` and `coupons.retrieve` against the LIVE key
 * from .env. Run after any pricing change, any new price id, or any coupon
 * edit in the Stripe dashboard.
 *
 * Usage:
 *   npx tsx debug/stripe-price-parity-probe.ts
 */
import Stripe from "stripe";

import { getCommitmentMonths, getPeriodPricing, type BillingPeriod } from "../src/lib/plans/tier";
import { loadEnv } from "./_shared";

loadEnv();

const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
if (!key.startsWith("sk_")) {
  console.error("STRIPE_SECRET_KEY missing from the environment.");
  process.exit(2);
}
const stripe = new Stripe(key);

type Tier = "starter" | "standard";
const TIERS: Tier[] = ["starter", "standard"];
const SUFFIX: Record<BillingPeriod, string> = {
  biennial: "24MO",
  annual: "12MO",
  monthly: "1MO"
};

let failures = 0;
function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}

async function checkPrice(
  envKey: string,
  expectedCents: number,
  expectedIntervalCount: number,
  label: string
): Promise<void> {
  const id = process.env[envKey];
  if (!id) {
    report(label, false, `${envKey} not set`);
    return;
  }
  try {
    const price = await stripe.prices.retrieve(id);
    const amountOk = price.unit_amount === expectedCents;
    const shapeOk =
      price.active === true &&
      price.currency === "usd" &&
      price.recurring?.interval === "month" &&
      (price.recurring?.interval_count ?? 1) === expectedIntervalCount;
    report(
      label,
      amountOk && shapeOk,
      `unit_amount=${price.unit_amount} expected=${expectedCents}, active=${price.active}, ` +
        `${price.currency}/${price.recurring?.interval ?? "one_time"}x${price.recurring?.interval_count ?? "-"} expected x${expectedIntervalCount}`
    );
  } catch (err) {
    report(label, false, err instanceof Error ? err.message : String(err));
  }
}

async function checkIntroCoupon(tier: Tier): Promise<void> {
  const envKey = `STRIPE_${tier.toUpperCase()}_1MO_INTRO_COUPON_ID`;
  const label = `${tier} monthly intro coupon`;
  const id = process.env[envKey];
  if (!id) {
    report(label, false, `${envKey} not set`);
    return;
  }
  const monthly = getPeriodPricing(tier, "monthly");
  const expectedOff = monthly.renewalMonthlyCents - monthly.monthlyCents;
  try {
    const coupon = await stripe.coupons.retrieve(id);
    const isAmountOff = typeof coupon.amount_off === "number" && coupon.percent_off == null;
    const amountOk = coupon.amount_off === expectedOff;
    report(
      label,
      isAmountOff && amountOk && coupon.valid === true,
      `amount_off=${coupon.amount_off} expected=${expectedOff}, percent_off=${coupon.percent_off}, valid=${coupon.valid}`
    );
  } catch (err) {
    report(label, false, err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  for (const tier of TIERS) {
    for (const period of ["biennial", "annual"] as const) {
      const pricing = getPeriodPricing(tier, period);
      const suffix = SUFFIX[period];
      const months = getCommitmentMonths(period);
      // The contract price bills the WHOLE term as one charge (monthlyCents
      // x months, interval month x months); the renewal price is the
      // month-to-month rollover (renewalMonthlyCents, month x 1).
      await checkPrice(
        `STRIPE_${tier.toUpperCase()}_${suffix}_PRICE_ID`,
        pricing.monthlyCents * months,
        months,
        `${tier} ${period} contract price`
      );
      await checkPrice(
        `STRIPE_${tier.toUpperCase()}_${suffix}_RENEWAL_PRICE_ID`,
        pricing.renewalMonthlyCents,
        1,
        `${tier} ${period} renewal price`
      );
    }
    // Monthly: one ongoing price at the renewal rate; the intro coupon
    // brings the first month down to the contract rate.
    const monthly = getPeriodPricing(tier, "monthly");
    await checkPrice(
      `STRIPE_${tier.toUpperCase()}_1MO_PRICE_ID`,
      monthly.renewalMonthlyCents,
      1,
      `${tier} monthly ongoing price`
    );
    await checkIntroCoupon(tier);
  }

  console.log(
    failures === 0
      ? "\nAll live Stripe amounts match src/lib/plans/tier.ts."
      : `\n${failures} mismatch(es): the app quotes numbers Stripe does not charge (or vice versa).`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
