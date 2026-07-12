import { describe, expect, it } from "vitest";

import {
  computeDayCurrentMrr,
  estimateMonthlyPlatformCost,
  type MrrSubscriptionInput,
  type PlatformCostBusinessInput
} from "@/lib/admin/mrr";
import { getPeriodPricing } from "@/lib/plans/tier";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  VOICE_ALL_IN_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";

const NOW = new Date("2026-07-10T12:00:00Z");

function sub(overrides: Partial<MrrSubscriptionInput> = {}): MrrSubscriptionInput {
  return {
    tier: "standard",
    status: "active",
    stripe_subscription_id: "sub_123",
    billing_period: "biennial",
    renewal_at: "2028-06-01T00:00:00Z",
    stripe_current_period_start: "2026-06-01T00:00:00Z",
    stripe_current_period_end: "2028-06-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    ...overrides
  };
}

describe("computeDayCurrentMrr", () => {
  it("prices an in-term subscription at the contract rate", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub()],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(getPeriodPricing("standard", "biennial").monthlyCents);
    expect(result.totalCents).toBe(9900);
    expect(result.countedSubscriptions).toBe(1);
  });

  it("prices a rolled-over term subscription at the renewal rate (past renewal_at + monthly Stripe period)", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: "2026-06-15T00:00:00Z",
          stripe_current_period_end: "2026-07-15T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(
      getPeriodPricing("standard", "biennial").renewalMonthlyCents
    );
    expect(result.totalCents).toBe(18_900);
  });

  it("keeps the contract rate past renewal_at while the Stripe period is still term-length (auto-renewed contract)", () => {
    // renewal_at is never advanced on an auto-renewed full term — the
    // 24-month Stripe period is what says "still committed".
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: "2026-06-15T00:00:00Z",
          stripe_current_period_end: "2028-06-15T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(9900);
  });

  it("fails toward the contract rate when the Stripe period cache is missing (same direction as the billing page)", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: null,
          stripe_current_period_end: null
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(9900);
  });

  it("prices a monthly plan at the intro rate inside its first month, renewal rate after", () => {
    // renewal_at stamped at checkout (created + 1 month) still ahead of NOW.
    const inIntro = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: "2026-08-01T00:00:00Z",
          created_at: "2026-07-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(inIntro.subscriptionCents).toBe(getPeriodPricing("starter", "monthly").monthlyCents);

    // Missing renewal_at falls back to created_at + 1 month; created two
    // months ago → ongoing renewal rate.
    const ongoing = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: null,
          created_at: "2026-05-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(ongoing.subscriptionCents).toBe(
      getPeriodPricing("starter", "monthly").renewalMonthlyCents
    );

    // Malformed renewal_at takes the same created_at fallback — created this
    // month → still intro.
    const malformed = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: "not-a-date",
          created_at: "2026-07-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(malformed.subscriptionCents).toBe(getPeriodPricing("starter", "monthly").monthlyCents);
  });

  it("clamps month-end anchors for the monthly intro fallback (Jan 31 + 1mo = Feb 28, not Mar 3)", () => {
    // Naive month addition would put the intro end at Mar 3 and misclassify
    // Mar 1 as intro-priced; clamped math ends the intro month on Feb 28.
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: null,
          created_at: "2026-01-31T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: new Date("2026-03-01T00:00:00Z")
    });
    expect(result.subscriptionCents).toBe(
      getPeriodPricing("starter", "monthly").renewalMonthlyCents
    );
  });

  it("treats a null billing_period as monthly", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ billing_period: null, renewal_at: null, created_at: "2026-07-05T00:00:00Z" })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(getPeriodPricing("standard", "monthly").monthlyCents);
  });

  it("excludes non-active and Stripe-less subscriptions", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ status: "pending" }),
        sub({ status: "canceled" }),
        sub({ stripe_subscription_id: null })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(0);
    expect(result.countedSubscriptions).toBe(0);
  });

  it("prices enterprise from active deals, never the tier table", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub({ tier: "enterprise" })],
      enterpriseDeals: [{ monthly_cents: 49_500 }, { monthly_cents: 120_000 }],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(0);
    expect(result.enterpriseDealCents).toBe(169_500);
    expect(result.totalCents).toBe(169_500);
  });

  it("defaults `now` to the current time", () => {
    // Term end far in the future so the assertion is stable under real time.
    const result = computeDayCurrentMrr({
      subscriptions: [sub({ renewal_at: "2099-01-01T00:00:00Z" })],
      enterpriseDeals: []
    });
    expect(result.totalCents).toBe(9900);
  });
});

function biz(overrides: Partial<PlatformCostBusinessInput> = {}): PlatformCostBusinessInput {
  return {
    tier: "standard",
    status: "online",
    hostinger_vps_id: "12345",
    vps_size: "kvm2",
    vps_provider: "hostinger",
    ...overrides
  };
}

describe("estimateMonthlyPlatformCost", () => {
  const NO_USAGE = { smsSent: 0, voiceMinutes: 0 };

  it("sums the Hostinger SKU + one DID per provisioned box", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [biz(), biz({ tier: "starter", vps_size: "kvm1" })],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0
    });
    expect(result.hostingCents).toBe(
      HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2 + HOSTING_MONTHLY_CENTS_BY_SIZE.kvm1
    );
    expect(result.didCents).toBe(2 * ENTERPRISE_UNIT_COSTS.didMonthlyCents);
    expect(result.boxCount).toBe(2);
    expect(result.totalCents).toBe(result.hostingCents + result.didCents);
  });

  it("resolves a missing vps_size pin through the deployed-size fallback (legacy standard → kvm8)", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [biz({ vps_size: null })],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0
    });
    expect(result.hostingCents).toBe(HOSTING_MONTHLY_CENTS_BY_SIZE.kvm8);
  });

  it("skips wiped tenants and businesses without a box", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [biz({ status: "wiped" }), biz({ hostinger_vps_id: null })],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0
    });
    expect(result.boxCount).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  it("counts a DID but no hosting for BYOS boxes (customer-owned hardware)", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [biz({ vps_provider: "byos" })],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0
    });
    expect(result.hostingCents).toBe(0);
    expect(result.didCents).toBe(ENTERPRISE_UNIT_COSTS.didMonthlyCents);
    expect(result.boxCount).toBe(1);
  });

  it("prices metered SMS/voice usage and AI spend, rounding once per component", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [],
      monthUsage: { smsSent: 100, voiceMinutes: 50 },
      aiSpendMicros: 1_234_999 // $1.234999 → 123 cents
    });
    expect(result.usageCents).toBe(
      Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage + 50 * VOICE_ALL_IN_CENTS_PER_MINUTE
      )
    );
    expect(result.aiSpendCents).toBe(123);
    expect(result.totalCents).toBe(result.usageCents + result.aiSpendCents);
  });

  it("prefers synced Hostinger prices per business, falling back per box", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [
        biz({ id: "biz-synced" }),
        biz({ id: "biz-unsynced" }),
        biz() // no id — estimate-only caller shape
      ],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0,
      actuals: { hostingCentsByBusinessId: new Map([["biz-synced", 1499]]) }
    });
    expect(result.hostingCents).toBe(1499 + 2 * HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2);
  });

  it("falls back to the SKU table when ids are present but no actuals map is given", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [biz({ id: "biz-1" })],
      monthUsage: NO_USAGE,
      aiSpendMicros: 0,
      actuals: {}
    });
    expect(result.hostingCents).toBe(HOSTING_MONTHLY_CENTS_BY_SIZE.kvm2);
  });

  it("replaces the usage estimate with Telnyx invoice actuals + Gemini voice rate", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [],
      monthUsage: { smsSent: 999, voiceMinutes: 999 },
      aiSpendMicros: 0,
      actuals: { telnyxMonthCostCents: 720.4, geminiVoiceCents: 69.75 }
    });
    expect(result.usageCents).toBe(Math.round(720.4 + 69.75));
  });

  it("defaults the Gemini voice top-up to zero when only the Telnyx actual is present", () => {
    const result = estimateMonthlyPlatformCost({
      businesses: [],
      monthUsage: { smsSent: 999, voiceMinutes: 999 },
      aiSpendMicros: 0,
      actuals: { telnyxMonthCostCents: 720 }
    });
    expect(result.usageCents).toBe(720);
  });
});
