import { describe, it, expect } from "vitest";
import {
  computeBusinessMargin,
  computeFleetMarginTotals,
  stripeMonthlyFeeCents,
  type BusinessMarginInput
} from "@/lib/admin/margin";
import { getPeriodPricing } from "@/lib/plans/tier";
import { monthlyPackAddonCents } from "@/lib/billing/membership-pack-addons";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE
} from "@/lib/plans/enterprise-pricing";
import {
  DOMESTIC_STRIPE_FEE_RATE,
  INTERNATIONAL_STRIPE_FEE_RATE,
  deriveStripeFeeRate
} from "@/lib/plans/stripe-fees";

const NOW = new Date("2026-07-12T18:00:00.000Z");

function input(overrides: Partial<BusinessMarginInput> = {}): BusinessMarginInput {
  return {
    businessId: "biz-1",
    tier: "standard",
    status: "online",
    hostingerVpsId: "1800980",
    vpsSize: "kvm2",
    vpsProvider: "hostinger",
    subscription: {
      tier: "standard",
      status: "active",
      stripe_subscription_id: "sub_stripe",
      billing_period: "monthly",
      renewal_at: "2026-08-01T00:00:00.000Z", // intro month still running at NOW
      stripe_current_period_start: "2026-07-01T00:00:00.000Z",
      stripe_current_period_end: "2026-08-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z"
    },
    enterpriseDealMonthlyCents: null,
    hostingerMonthlyPriceCents: null,
    telnyxMonthCostMicros: null,
    didCount: 1,
    monthSmsSent: 0,
    monthVoiceMinutes: 0,
    aiSpendMicros: 0,
    ...overrides
  };
}

function line(result: ReturnType<typeof computeBusinessMargin>, key: string) {
  return result.lines.find((l) => l.key === key);
}

describe("stripeMonthlyFeeCents", () => {
  it("charges 2.9% + $0.30 on a monthly plan", () => {
    expect(stripeMonthlyFeeCents(10_000, 1)).toBeCloseTo(10_000 * 0.029 + 30, 5);
  });

  it("spreads the fixed fee across a prepaid term (canvas biennial math)", () => {
    // $189/mo biennial → one charge of $4,536; $0.30 spread over 24 months.
    const fee = stripeMonthlyFeeCents(18_900, 24);
    expect(fee).toBeCloseTo(18_900 * 0.029 + 30 / 24, 5);
  });

  it("clamps a sub-1 commitment to monthly", () => {
    expect(stripeMonthlyFeeCents(10_000, 0)).toBeCloseTo(10_000 * 0.029 + 30, 5);
  });
});

describe("computeBusinessMargin, revenue", () => {
  it("prices an active Stripe-backed subscription at the day-current rate", () => {
    const result = computeBusinessMargin(input(), NOW);
    expect(result.revenueSource).toBe("subscription");
    expect(result.revenueCents).toBe(getPeriodPricing("standard", "monthly").monthlyCents);
    expect(line(result, "stripe_fees")?.cents).toBe(
      Math.round(stripeMonthlyFeeCents(result.revenueCents, 1))
    );
  });

  it("spreads Stripe fees over the term for committed plans and defaults null period to monthly", () => {
    const biennial = computeBusinessMargin(
      input({
        subscription: {
          tier: "standard",
          status: "active",
          stripe_subscription_id: "sub_stripe",
          billing_period: "biennial",
          renewal_at: "2028-07-01T00:00:00.000Z",
          stripe_current_period_start: "2026-07-01T00:00:00.000Z",
          stripe_current_period_end: "2028-07-01T00:00:00.000Z",
          created_at: "2026-07-01T00:00:00.000Z"
        }
      }),
      NOW
    );
    expect(biennial.revenueCents).toBe(getPeriodPricing("standard", "biennial").monthlyCents);
    expect(line(biennial, "stripe_fees")?.cents).toBe(
      Math.round(stripeMonthlyFeeCents(biennial.revenueCents, 24))
    );

    const nullPeriod = computeBusinessMargin(
      input({
        subscription: { ...input().subscription!, billing_period: null }
      }),
      NOW
    );
    expect(nullPeriod.revenueSource).toBe("subscription");
    expect(line(nullPeriod, "stripe_fees")?.cents).toBe(
      Math.round(stripeMonthlyFeeCents(nullPeriod.revenueCents, 1))
    );
  });

  it("prices enterprise from the active deal (monthly Stripe fee) and ignores its subscription row", () => {
    const result = computeBusinessMargin(
      input({
        tier: "enterprise",
        enterpriseDealMonthlyCents: 250_000,
        subscription: { ...input().subscription!, tier: "enterprise" }
      }),
      NOW
    );
    expect(result.revenueSource).toBe("enterprise_deal");
    expect(result.revenueCents).toBe(250_000);
    expect(line(result, "stripe_fees")?.cents).toBe(
      Math.round(stripeMonthlyFeeCents(250_000, 1))
    );
  });

  it("counts no revenue (and no Stripe line) for missing, non-active, Stripe-less, or enterprise-tier subscriptions", () => {
    for (const subscription of [
      null,
      { ...input().subscription!, status: "pending" },
      { ...input().subscription!, stripe_subscription_id: null },
      { ...input().subscription!, tier: "enterprise" as const }
    ]) {
      const result = computeBusinessMargin(input({ subscription }), NOW);
      expect(result.revenueSource).toBe("none");
      expect(result.revenueCents).toBe(0);
      expect(line(result, "stripe_fees")).toBeUndefined();
    }
  });
});

describe("computeBusinessMargin, cost lines", () => {
  it("uses the synced Hostinger price when present, the SKU table otherwise", () => {
    const synced = computeBusinessMargin(input({ hostingerMonthlyPriceCents: 1499 }), NOW);
    expect(line(synced, "hosting")).toMatchObject({ cents: 1499, source: "actual" });

    const estimated = computeBusinessMargin(input(), NOW);
    expect(line(estimated, "hosting")).toMatchObject({
      cents: HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2,
      source: "estimate"
    });
  });

  it("skips hosting for BYOS, wiped, and box-less businesses", () => {
    const byos = computeBusinessMargin(input({ vpsProvider: "byos" }), NOW);
    expect(line(byos, "hosting")).toBeUndefined();
    expect(line(byos, "did")?.cents).toBe(ENTERPRISE_UNIT_COSTS.didMonthlyCents);

    for (const overrides of [{ status: "wiped" }, { hostingerVpsId: null }]) {
      const gone = computeBusinessMargin(input(overrides), NOW);
      expect(line(gone, "hosting")).toBeUndefined();
    }
  });

  it("bills DIDs by number rented, not by box: a box-less tenant still pays", () => {
    // Truly Insurance's shape when the July 2026 invoice was reconciled: a
    // Canadian DID, no Hostinger box. The old box-gated line charged $0.
    const boxless = computeBusinessMargin(input({ hostingerVpsId: null, didCount: 1 }), NOW);
    expect(line(boxless, "did")?.cents).toBe(ENTERPRISE_UNIT_COSTS.didMonthlyCents);

    const two = computeBusinessMargin(input({ didCount: 2 }), NOW);
    expect(line(two, "did")).toMatchObject({
      cents: 2 * ENTERPRISE_UNIT_COSTS.didMonthlyCents,
      label: "Phone number rentals (2)"
    });

    // Renting nothing costs nothing, even with a live box.
    expect(line(computeBusinessMargin(input({ didCount: 0 }), NOW), "did")).toBeUndefined();
  });

  it("drops the DID line for a wiped tenant even if a settings row lingers", () => {
    const wiped = computeBusinessMargin(input({ status: "wiped", didCount: 3 }), NOW);
    expect(line(wiped, "did")).toBeUndefined();
  });

  it("falls back to one DID per live box when the DID list is unreadable", () => {
    const unreadable = computeBusinessMargin(input({ didCount: null }), NOW);
    expect(unreadable.lines.find((l) => l.key === "did")?.cents).toBe(
      ENTERPRISE_UNIT_COSTS.didMonthlyCents
    );
    const noBox = computeBusinessMargin(input({ didCount: null, hostingerVpsId: null }), NOW);
    expect(noBox.lines.find((l) => l.key === "did")).toBeUndefined();
  });

  it("uses Telnyx invoice actuals when synced, per-unit estimates otherwise", () => {
    const actual = computeBusinessMargin(
      input({ telnyxMonthCostMicros: 7_210_000, monthSmsSent: 455 }),
      NOW
    );
    expect(line(actual, "telnyx_usage")).toMatchObject({ cents: 721, source: "actual" });

    const estimate = computeBusinessMargin(
      input({ monthSmsSent: 100, monthVoiceMinutes: 31 }),
      NOW
    );
    expect(line(estimate, "telnyx_usage")).toMatchObject({
      cents: Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
          31 * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute
      ),
      source: "estimate"
    });
  });

  it("meters Gemini as ONE actuals line, no rate-estimated Live-voice duplicate", () => {
    // owner_chat_model_spend already includes Gemini Live audio (settled at
    // call teardown), so a separate settled-minutes × rate line would
    // double-count the voice component.
    const result = computeBusinessMargin(
      input({ aiSpendMicros: 410_000, monthVoiceMinutes: 31 }),
      NOW
    );
    expect(line(result, "gemini_chat")).toMatchObject({ cents: 41, source: "actual" });
    expect(result.lines.filter((l) => l.key.startsWith("gemini"))).toHaveLength(1);
  });

  it("sums rounded lines into costCents and marginCents", () => {
    const result = computeBusinessMargin(
      input({ monthSmsSent: 251, monthVoiceMinutes: 31, aiSpendMicros: 410_000 }),
      NOW
    );
    expect(result.costCents).toBe(result.lines.reduce((sum, l) => sum + l.cents, 0));
    expect(result.marginCents).toBe(result.revenueCents - result.costCents);
    // Amy-profile sanity: a standard tenant at ~10% caps clears well over $100/mo.
    expect(result.marginCents).toBeGreaterThan(10_000);
  });

  it("defaults `now` to the current time", () => {
    const result = computeBusinessMargin(input());
    expect(result.revenueSource).toBe("subscription");
  });
});

describe("computeFleetMarginTotals", () => {
  it("returns null margin % on an empty fleet", () => {
    expect(computeFleetMarginTotals([])).toEqual({
      revenueCents: 0,
      costCents: 0,
      marginCents: 0,
      marginPct: null,
      payingBusinesses: 0
    });
  });

  it("sums revenue/cost and counts paying businesses", () => {
    const paying = computeBusinessMargin(input(), NOW);
    const idle = computeBusinessMargin(input({ subscription: null }), NOW);
    const totals = computeFleetMarginTotals([paying, idle]);
    expect(totals.revenueCents).toBe(paying.revenueCents);
    expect(totals.costCents).toBe(paying.costCents + idle.costCents);
    expect(totals.marginCents).toBe(totals.revenueCents - totals.costCents);
    expect(totals.payingBusinesses).toBe(1);
    expect(totals.marginPct).toBe(
      Math.round((totals.marginCents / totals.revenueCents) * 1000) / 10
    );
  });
});

describe("computeBusinessMargin, Stripe fee rate", () => {
  /**
   * The default. Before this, EVERY tenant was priced here regardless of
   * where their card was issued.
   */
  it("estimates a US tenant at the domestic rate", () => {
    const result = computeBusinessMargin(input({ country: "US" }), NOW);
    const feeLine = line(result, "stripe_fees")!;
    expect(feeLine.source).toBe("estimate");
    expect(feeLine.label).toMatch(/card region/);
    expect(feeLine.cents).toBe(
      Math.round(stripeMonthlyFeeCents(result.revenueCents, 1, DOMESTIC_STRIPE_FEE_RATE))
    );
  });

  it("defaults an unspecified country to the domestic rate", () => {
    const withCountry = computeBusinessMargin(input({ country: "US" }), NOW);
    const without = computeBusinessMargin(input(), NOW);
    expect(line(without, "stripe_fees")?.cents).toBe(line(withCountry, "stripe_fees")?.cents);
  });

  /**
   * A non-US tenant's card almost certainly carries Stripe's international
   * surcharge, so the domestic rate understates their fee by roughly half.
   */
  it("estimates a non-US tenant at the international rate, costing strictly more", () => {
    const us = computeBusinessMargin(input({ country: "US" }), NOW);
    const mx = computeBusinessMargin(input({ country: "MX" }), NOW);
    expect(line(mx, "stripe_fees")!.cents).toBeGreaterThan(line(us, "stripe_fees")!.cents);
    expect(line(mx, "stripe_fees")!.cents).toBe(
      Math.round(stripeMonthlyFeeCents(mx.revenueCents, 1, INTERNATIONAL_STRIPE_FEE_RATE))
    );
    expect(mx.marginCents).toBeLessThan(us.marginCents);
  });

  /**
   * Observed fees beat any estimate: this is what makes the line reflect
   * what Stripe REALLY took, including surcharges we never enumerated.
   */
  it("derives the rate from observed fees and marks the line calibrated", () => {
    const result = computeBusinessMargin(
      input({
        country: "US",
        // 4.5% effective: a US-looking tenant paying on a foreign card.
        stripeObservedFees: { grossCents: 28_399, feeCents: 1280, chargeCount: 1 }
      }),
      NOW
    );
    const feeLine = line(result, "stripe_fees")!;
    expect(feeLine.source).toBe("calibrated");
    expect(feeLine.label).toMatch(/observed/);
    // Strictly more than the domestic estimate the country alone would give.
    expect(feeLine.cents).toBeGreaterThan(
      Math.round(stripeMonthlyFeeCents(result.revenueCents, 1, DOMESTIC_STRIPE_FEE_RATE))
    );
  });

  it("falls back to the country estimate when the observation is unusable", () => {
    const result = computeBusinessMargin(
      input({
        country: "US",
        // Zero charges: nothing to derive a rate from.
        stripeObservedFees: { grossCents: 0, feeCents: 0, chargeCount: 0 }
      }),
      NOW
    );
    const feeLine = line(result, "stripe_fees")!;
    expect(feeLine.source).toBe("estimate");
    expect(feeLine.cents).toBe(
      Math.round(stripeMonthlyFeeCents(result.revenueCents, 1, DOMESTIC_STRIPE_FEE_RATE))
    );
  });

  /**
   * The amount stays AMORTIZED even when the rate is observed. A biennial
   * tenant is charged once every 24 months; billing that whole fee into its
   * charge month would make monthly margin lurch, which is the same reason
   * the estimate spreads the $0.30.
   */
  it("keeps the fee amortized across a term plan while using the observed rate", () => {
    const observed = { grossCents: 28_399, feeCents: 1280, chargeCount: 1 };
    const biennial = computeBusinessMargin(
      input({
        subscription: { ...input().subscription!, billing_period: "biennial" },
        stripeObservedFees: observed
      }),
      NOW
    );
    const feeLine = line(biennial, "stripe_fees")!;
    expect(feeLine.source).toBe("calibrated");
    const rate = deriveStripeFeeRate(observed)!;
    expect(feeLine.cents).toBe(
      Math.round(stripeMonthlyFeeCents(biennial.revenueCents, 24, rate))
    );
    // The $0.30 is spread, so the monthly fee sits just under rate × price.
    expect(feeLine.cents).toBeLessThan(
      Math.round(biennial.revenueCents * rate.percent + rate.fixedCents)
    );
  });
});

describe("computeBusinessMargin - recurring pack add-ons", () => {
  const PACK_OPTIONS = [
    { category: "voice" as const, id: "min_30", label: "30 minutes", listPriceCents: 6000 }
  ];

  /**
   * Packs bill every cycle, so they are revenue. Counting only the plan rate
   * understated a pack-carrying tenant's margin AND made the fleet revenue
   * base disagree with the MRR card the Dashboard subtracts cost from, so
   * "MRR minus cost" visibly did not equal the net it printed.
   */
  it("counts pack revenue, matching computeDayCurrentMrr's basis", () => {
    const withPacks = computeBusinessMargin(
      input({
        subscription: {
          ...input().subscription!,
          membership_pack_addons: { addonVoice: "min_30:1:1800" }
        },
        packAddonOptions: PACK_OPTIONS
      }),
      NOW
    );
    const without = computeBusinessMargin(input({ packAddonOptions: PACK_OPTIONS }), NOW);

    expect(withPacks.revenueCents).toBeGreaterThan(without.revenueCents);
    expect(withPacks.revenueCents).toBe(
      without.revenueCents +
        monthlyPackAddonCents({ addonVoice: "min_30:1:1800" }, "monthly", PACK_OPTIONS)
    );
    // Stripe's cut rides the larger charge too.
    expect(line(withPacks, "stripe_fees")!.cents).toBeGreaterThan(
      line(without, "stripe_fees")!.cents
    );
  });

  it("prices an unknown pack id as zero rather than erroring", () => {
    const result = computeBusinessMargin(
      input({
        subscription: {
          ...input().subscription!,
          membership_pack_addons: { addonVoice: "retired_pack:1:1800" }
        },
        packAddonOptions: PACK_OPTIONS
      }),
      NOW
    );
    expect(result.revenueCents).toBe(
      computeBusinessMargin(input({ packAddonOptions: PACK_OPTIONS }), NOW).revenueCents
    );
  });
});
