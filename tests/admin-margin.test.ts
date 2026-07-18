import { describe, it, expect } from "vitest";
import {
  computeBusinessMargin,
  computeFleetMarginTotals,
  stripeMonthlyFeeCents,
  type BusinessMarginInput
} from "@/lib/admin/margin";
import { getPeriodPricing } from "@/lib/plans/tier";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE
} from "@/lib/plans/enterprise-pricing";

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

describe("computeBusinessMargin — revenue", () => {
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

describe("computeBusinessMargin — cost lines", () => {
  it("uses the synced Hostinger price when present, the SKU table otherwise", () => {
    const synced = computeBusinessMargin(input({ hostingerMonthlyPriceCents: 1499 }), NOW);
    expect(line(synced, "hosting")).toMatchObject({ cents: 1499, source: "actual" });

    const estimated = computeBusinessMargin(input(), NOW);
    expect(line(estimated, "hosting")).toMatchObject({
      cents: HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2,
      source: "estimate"
    });
  });

  it("skips hosting for BYOS (still a DID) and both for wiped/box-less businesses", () => {
    const byos = computeBusinessMargin(input({ vpsProvider: "byos" }), NOW);
    expect(line(byos, "hosting")).toBeUndefined();
    expect(line(byos, "did")?.cents).toBe(ENTERPRISE_UNIT_COSTS.didMonthlyCents);

    for (const overrides of [{ status: "wiped" }, { hostingerVpsId: null }]) {
      const gone = computeBusinessMargin(input(overrides), NOW);
      expect(line(gone, "hosting")).toBeUndefined();
      expect(line(gone, "did")).toBeUndefined();
    }
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

  it("meters Gemini as ONE actuals line — no rate-estimated Live-voice duplicate", () => {
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
