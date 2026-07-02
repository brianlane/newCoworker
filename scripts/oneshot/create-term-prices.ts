#!/usr/bin/env tsx
/**
 * One-shot: create the FULL-TERM Stripe prices for the 12/24-month plans.
 *
 * Why: the original "24-month" prices were $X/month recurring, so checkout
 * only collected one month — but the tenant's Hostinger VPS is prepaid for
 * the whole contract. These new prices bill the entire commitment upfront
 * (`interval=month`, `interval_count=12|24`, `unit_amount = monthly × months`)
 * while the Stripe subscription still renews per term. Renewal prices
 * (`*_RENEWAL_PRICE_ID`, already plain monthly) are untouched — they drive
 * the month-to-month rollover phase via `ensureCommitmentSchedule`.
 *
 * Idempotent: each price is created with a stable `lookup_key`
 * (`nc_<tier>_<months>mo_full_term_v1`); an existing active price with that
 * key is reused, never duplicated. Products are reused from the current
 * per-month price env vars.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/create-term-prices.ts            # dry-run
 *   npx tsx scripts/oneshot/create-term-prices.ts --apply    # create in Stripe
 *
 * Requires: STRIPE_SECRET_KEY plus the existing
 * STRIPE_{STARTER,STANDARD}_{12,24}MO_PRICE_ID vars (for product reuse).
 *
 * After --apply: point STRIPE_{STARTER,STANDARD}_{12,24}MO_PRICE_ID at the
 * printed ids in Vercel env + local .env (the script prints the exact lines).
 */
import Stripe from "stripe";
import { getPeriodPricing, getCommitmentMonths, type BillingPeriod } from "@/lib/plans/tier";

const APPLY = process.argv.includes("--apply");

type Target = {
  tier: "starter" | "standard";
  period: Exclude<BillingPeriod, "monthly">;
};

const TARGETS: Target[] = [
  { tier: "starter", period: "biennial" },
  { tier: "starter", period: "annual" },
  { tier: "standard", period: "biennial" },
  { tier: "standard", period: "annual" }
];

function envSuffix(period: Exclude<BillingPeriod, "monthly">): string {
  return period === "biennial" ? "24MO" : "12MO";
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error("STRIPE_SECRET_KEY is not set (source .env first)");
    process.exit(2);
  }
  const stripe = new Stripe(secret, { apiVersion: "2026-06-24.dahlia" });
  const isLive = secret.startsWith("sk_live");
  console.log(`[term-prices] mode=${APPLY ? "APPLY" : "dry-run"} stripe=${isLive ? "LIVE" : "test"}`);

  const envLines: string[] = [];

  for (const { tier, period } of TARGETS) {
    const months = getCommitmentMonths(period);
    const { monthlyCents } = getPeriodPricing(tier, period);
    const totalCents = monthlyCents * months;
    const lookupKey = `nc_${tier}_${months}mo_full_term_v1`;
    const envKey = `STRIPE_${tier.toUpperCase()}_${envSuffix(period)}_PRICE_ID`;

    // Idempotency: reuse an existing active price with our lookup key.
    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (existing.data[0]) {
      const p = existing.data[0];
      console.log(
        `[term-prices] ${lookupKey}: already exists → ${p.id} ` +
          `(${formatUsd(p.unit_amount ?? 0)} per ${p.recurring?.interval_count} ${p.recurring?.interval})`
      );
      envLines.push(`${envKey}=${p.id}`);
      continue;
    }

    // Reuse the product of the currently-configured per-month price.
    const currentPriceId = process.env[envKey];
    if (!currentPriceId) {
      console.error(`[term-prices] ${envKey} is not set — cannot resolve the product to attach to`);
      process.exit(2);
    }
    const currentPrice = await stripe.prices.retrieve(currentPriceId);
    const productId =
      typeof currentPrice.product === "string" ? currentPrice.product : currentPrice.product.id;

    console.log(
      `[term-prices] ${lookupKey}: will create ${formatUsd(totalCents)} per ${months} months ` +
        `on product ${productId} (replacing per-month ${currentPriceId})`
    );

    if (!APPLY) {
      envLines.push(`${envKey}=<created on --apply>`);
      continue;
    }

    const price = await stripe.prices.create({
      product: productId,
      currency: "usd",
      unit_amount: totalCents,
      recurring: { interval: "month", interval_count: months },
      lookup_key: lookupKey,
      nickname: `${tier} ${months}-month term, billed upfront`,
      metadata: {
        nc_tier: tier,
        nc_billing_period: period,
        nc_commitment_months: String(months),
        nc_effective_monthly_cents: String(monthlyCents)
      }
    });
    console.log(`[term-prices] ${lookupKey}: created ${price.id}`);
    envLines.push(`${envKey}=${price.id}`);
  }

  console.log("\n[term-prices] set these in Vercel env + local .env:");
  for (const line of envLines) console.log(`  ${line}`);
  if (!APPLY) console.log("\n[term-prices] dry-run only — re-run with --apply to create the prices.");
}

void main().catch((err) => {
  console.error("[term-prices] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
