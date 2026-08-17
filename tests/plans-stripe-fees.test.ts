import { describe, it, expect } from "vitest";
import {
  DOMESTIC_STRIPE_FEE_RATE,
  INTERNATIONAL_STRIPE_FEE_RATE,
  MAX_DERIVED_STRIPE_PERCENT,
  MIN_DERIVED_STRIPE_PERCENT,
  deriveStripeFeeRate,
  stripeFeeRateForCountry
} from "@/lib/plans/stripe-fees";
import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";

describe("stripe fee rates", () => {
  it("prices a US card at Stripe's headline rate", () => {
    expect(DOMESTIC_STRIPE_FEE_RATE).toEqual({ percent: 0.029, fixedCents: 30 });
  });

  /**
   * The whole point of this module: a non-US card costs 2.9% + 1.5%, and
   * modeling it at 2.9% understates the fee by roughly half.
   */
  it("adds the international surcharge for a non-US card", () => {
    expect(INTERNATIONAL_STRIPE_FEE_RATE.percent).toBeCloseTo(0.044, 10);
    expect(INTERNATIONAL_STRIPE_FEE_RATE.fixedCents).toBe(30);
    expect(INTERNATIONAL_STRIPE_FEE_RATE.percent).toBeGreaterThan(
      DOMESTIC_STRIPE_FEE_RATE.percent
    );
  });

  it("keys the fallback rate on the tenant's country", () => {
    expect(stripeFeeRateForCountry("US")).toBe(DOMESTIC_STRIPE_FEE_RATE);
    expect(stripeFeeRateForCountry("CA")).toBe(INTERNATIONAL_STRIPE_FEE_RATE);
    expect(stripeFeeRateForCountry("MX")).toBe(INTERNATIONAL_STRIPE_FEE_RATE);
  });
});

describe("deriveStripeFeeRate", () => {
  /**
   * The live case that started this: one $283.99 charge showed $12.80 of
   * real Stripe fees (gross $283.99 → net $271.19), a 4.5% effective rate
   * against the 2.9% the margin engine assumed. Backing the percentage out
   * of those totals must recover the international rate.
   */
  it("recovers the real rate from an observed international charge", () => {
    const rate = deriveStripeFeeRate({
      grossCents: 28_399,
      feeCents: 1280,
      chargeCount: 1
    });
    expect(rate).not.toBeNull();
    expect(rate!.percent).toBeCloseTo(0.044, 3);
    expect(rate!.fixedCents).toBe(30);
  });

  it("recovers the domestic rate from ordinary US charges", () => {
    // Two charges at exactly 2.9% + $0.30 each.
    const grossCents = 10_000 + 20_000;
    const feeCents = Math.round(grossCents * 0.029) + 60;
    const rate = deriveStripeFeeRate({ grossCents, feeCents, chargeCount: 2 });
    expect(rate!.percent).toBeCloseTo(0.029, 4);
  });

  it("returns null when there is nothing to derive from", () => {
    expect(deriveStripeFeeRate({ grossCents: 0, feeCents: 0, chargeCount: 0 })).toBeNull();
    expect(deriveStripeFeeRate({ grossCents: 10_000, feeCents: 320, chargeCount: 0 })).toBeNull();
    expect(deriveStripeFeeRate({ grossCents: 0, feeCents: 320, chargeCount: 1 })).toBeNull();
    expect(
      deriveStripeFeeRate({ grossCents: -5_000, feeCents: 320, chargeCount: 1 })
    ).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(
      deriveStripeFeeRate({ grossCents: Number.NaN, feeCents: 320, chargeCount: 1 })
    ).toBeNull();
    expect(
      deriveStripeFeeRate({ grossCents: 10_000, feeCents: Number.NaN, chargeCount: 1 })
    ).toBeNull();
    expect(
      deriveStripeFeeRate({ grossCents: 10_000, feeCents: 320, chargeCount: Number.NaN })
    ).toBeNull();
  });

  /**
   * A window polluted by a dispute fee or a refund that returned the amount
   * but not the fee is NOT a clean read of card pricing. Rejecting beats
   * clamping: the tenant falls back to the country estimate instead of
   * carrying a garbage rate that looks authoritative.
   */
  it("rejects a derived rate outside the plausible band", () => {
    const fixed = ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge;
    const tooLow = {
      grossCents: 100_000,
      feeCents: Math.round(100_000 * (MIN_DERIVED_STRIPE_PERCENT - 0.005)) + fixed,
      chargeCount: 1
    };
    const tooHigh = {
      grossCents: 100_000,
      feeCents: Math.round(100_000 * (MAX_DERIVED_STRIPE_PERCENT + 0.005)) + fixed,
      chargeCount: 1
    };
    expect(deriveStripeFeeRate(tooLow)).toBeNull();
    expect(deriveStripeFeeRate(tooHigh)).toBeNull();
  });

  it("accepts a rate sitting exactly on each band edge", () => {
    const fixed = ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge;
    const atMin = deriveStripeFeeRate({
      grossCents: 100_000,
      feeCents: 100_000 * MIN_DERIVED_STRIPE_PERCENT + fixed,
      chargeCount: 1
    });
    const atMax = deriveStripeFeeRate({
      grossCents: 100_000,
      feeCents: 100_000 * MAX_DERIVED_STRIPE_PERCENT + fixed,
      chargeCount: 1
    });
    expect(atMin!.percent).toBeCloseTo(MIN_DERIVED_STRIPE_PERCENT, 10);
    expect(atMax!.percent).toBeCloseTo(MAX_DERIVED_STRIPE_PERCENT, 10);
  });
});
