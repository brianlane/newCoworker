import { describe, expect, it } from "vitest";

import {
  computeArpuCents,
  computeChurnStats,
  computeMrrTrend,
  computeTopBusinessRevenue,
  dedupeNewestPerBusiness,
  listPaymentProblems,
  wasSubscriptionActiveAt,
  type RevenueDeal,
  type RevenueSubscription
} from "@/lib/admin/revenue";
import { getPeriodPricing } from "@/lib/plans/tier";

const NOW = new Date("2026-07-10T12:00:00Z");
const STANDARD_MONTHLY = getPeriodPricing("standard", "biennial").monthlyCents; // 9900

function sub(overrides: Partial<RevenueSubscription> = {}): RevenueSubscription {
  return {
    business_id: "biz-1",
    tier: "standard",
    status: "active",
    stripe_subscription_id: "sub_123",
    billing_period: "biennial",
    renewal_at: "2028-06-01T00:00:00Z",
    stripe_current_period_start: "2026-06-01T00:00:00Z",
    stripe_current_period_end: "2028-06-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    canceled_at: null,
    cancel_reason: null,
    ...overrides
  };
}

function deal(overrides: Partial<RevenueDeal> = {}): RevenueDeal {
  return {
    business_id: "ent-1",
    monthly_cents: 250_000,
    status: "active",
    activated_at: "2026-05-15T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

describe("dedupeNewestPerBusiness", () => {
  it("keeps only the newest row per business, regardless of input order", () => {
    const older = sub({ business_id: "b1", created_at: "2026-01-01T00:00:00Z", status: "canceled" });
    const newer = sub({ business_id: "b1", created_at: "2026-06-01T00:00:00Z" });
    const other = sub({ business_id: "b2" });
    expect(dedupeNewestPerBusiness([newer, older, other])).toEqual([newer, other]);
    expect(dedupeNewestPerBusiness([older, newer, other])).toEqual([newer, other]);
  });
});

describe("wasSubscriptionActiveAt", () => {
  const at = new Date("2026-06-15T00:00:00Z");

  it("is false before creation and for pending rows", () => {
    expect(wasSubscriptionActiveAt(sub({ created_at: "2026-07-01T00:00:00Z" }), at)).toBe(false);
    expect(wasSubscriptionActiveAt(sub({ status: "pending" }), at)).toBe(false);
  });

  it("is true for active rows created before the anchor; past_due matches the MRR definition (excluded)", () => {
    expect(wasSubscriptionActiveAt(sub(), at)).toBe(true);
    expect(wasSubscriptionActiveAt(sub({ status: "past_due" }), at)).toBe(false);
  });

  it("canceled rows count only while canceled_at is still in the future", () => {
    expect(
      wasSubscriptionActiveAt(sub({ status: "canceled", canceled_at: "2026-06-20T00:00:00Z" }), at)
    ).toBe(true);
    expect(
      wasSubscriptionActiveAt(sub({ status: "canceled", canceled_at: "2026-06-10T00:00:00Z" }), at)
    ).toBe(false);
    expect(wasSubscriptionActiveAt(sub({ status: "canceled", canceled_at: null }), at)).toBe(false);
    expect(
      wasSubscriptionActiveAt(sub({ status: "canceled", canceled_at: "not-a-date" }), at)
    ).toBe(false);
  });

  it("tolerates an unparseable created_at (treated as not-after the anchor)", () => {
    expect(wasSubscriptionActiveAt(sub({ created_at: "garbage" }), at)).toBe(true);
  });
});

describe("computeMrrTrend", () => {
  it("evaluates each month-end: pre-creation months are 0, later months carry the rate", () => {
    const trend = computeMrrTrend({
      subscriptions: [sub({ created_at: "2026-06-01T00:00:00Z" })],
      deals: [],
      months: 3,
      now: NOW
    });
    expect(trend.map((p) => p.monthKey)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(trend.map((p) => p.totalCents)).toEqual([0, STANDARD_MONTHLY, STANDARD_MONTHLY]);
    expect(trend[2].label).toBe("Jul");
  });

  it("drops a canceled subscription from months after its cancel and includes deals from activation", () => {
    const trend = computeMrrTrend({
      subscriptions: [
        sub({
          status: "canceled",
          created_at: "2026-04-01T00:00:00Z",
          canceled_at: "2026-06-10T00:00:00Z"
        })
      ],
      deals: [deal()],
      months: 4,
      now: NOW
    });
    // Apr + May: sub active (deal starts May 15). Jun onward: sub canceled, deal only.
    expect(trend.map((p) => p.totalCents)).toEqual([
      STANDARD_MONTHLY,
      STANDARD_MONTHLY + 250_000,
      250_000,
      250_000
    ]);
  });

  it("defaults `now` to the wall clock", () => {
    const trend = computeMrrTrend({ subscriptions: [], deals: [], months: 1 });
    expect(trend).toHaveLength(1);
    expect(trend[0].totalCents).toBe(0);
  });

  it("ignores non-active deals, uses created_at when activated_at is missing, and defaults to 6 months", () => {
    const trend = computeMrrTrend({
      subscriptions: [],
      deals: [
        deal({ status: "open" }),
        deal({ activated_at: null, created_at: "2026-02-10T00:00:00Z", monthly_cents: 100_000 })
      ],
      now: NOW
    });
    expect(trend).toHaveLength(6);
    expect(trend.map((p) => p.totalCents)).toEqual([
      100_000, 100_000, 100_000, 100_000, 100_000, 100_000
    ]);
  });
});

describe("computeChurnStats", () => {
  it("computes churned businesses over currently-active businesses, Stripe-backed only", () => {
    const stats = computeChurnStats({
      subscriptions: [
        sub(),
        sub({ business_id: "b2" }),
        sub({ business_id: "b3", status: "canceled", canceled_at: "2026-07-01T00:00:00Z" }),
        // Outside the 30d window.
        sub({ business_id: "b4", status: "canceled", canceled_at: "2026-01-01T00:00:00Z" }),
        // Stripe-less rows never count either way.
        sub({ business_id: "b5", stripe_subscription_id: null }),
        // Canceled without a timestamp, and a pending row: neither counts.
        sub({ business_id: "b6", status: "canceled", canceled_at: null }),
        sub({ business_id: "b7", status: "pending" })
      ],
      now: NOW
    });
    expect(stats).toEqual({ canceledInWindow: 1, activeNow: 2, churnRatePct: 33.3 });
  });

  it("reads 100% on a full wipeout instead of a divide-by-zero 0%", () => {
    const stats = computeChurnStats({
      subscriptions: [
        sub({ business_id: "gone1", status: "canceled", canceled_at: "2026-07-01T00:00:00Z" }),
        sub({ business_id: "gone2", status: "canceled", canceled_at: "2026-07-02T00:00:00Z" })
      ],
      now: NOW
    });
    expect(stats).toEqual({ canceledInWindow: 2, activeNow: 0, churnRatePct: 100 });
  });

  it("counts per business: duplicate cancel rows count once and a resubscribed tenant didn't churn", () => {
    const stats = computeChurnStats({
      subscriptions: [
        // Two historical cancel rows for the same tenant inside the window.
        sub({ business_id: "gone", status: "canceled", canceled_at: "2026-07-01T00:00:00Z" }),
        sub({ business_id: "gone", status: "canceled", canceled_at: "2026-06-20T00:00:00Z" }),
        // Canceled in-window but resubscribed: active row wins, no churn.
        sub({ business_id: "back", status: "canceled", canceled_at: "2026-07-02T00:00:00Z" }),
        sub({ business_id: "back" }),
        // Two active rows for one tenant count once toward activeNow.
        sub({ business_id: "dupe-active" }),
        sub({ business_id: "dupe-active" })
      ],
      now: NOW
    });
    expect(stats).toEqual({ canceledInWindow: 1, activeNow: 2, churnRatePct: 33.3 });
  });

  it("ignores unparseable and future cancel timestamps and yields 0% with no active subs", () => {
    const stats = computeChurnStats({
      subscriptions: [
        sub({ status: "canceled", canceled_at: "garbage" }),
        sub({ status: "canceled", canceled_at: "2026-08-01T00:00:00Z" })
      ],
      now: NOW
    });
    expect(stats).toEqual({ canceledInWindow: 0, activeNow: 0, churnRatePct: 0 });
  });

  it("defaults `now` to the wall clock", () => {
    expect(computeChurnStats({ subscriptions: [] })).toEqual({
      canceledInWindow: 0,
      activeNow: 0,
      churnRatePct: 0
    });
  });

  it("honors a custom window", () => {
    const stats = computeChurnStats({
      subscriptions: [
        sub(),
        sub({ business_id: "b2", status: "canceled", canceled_at: "2026-07-05T00:00:00Z" })
      ],
      windowDays: 1,
      now: NOW
    });
    expect(stats.canceledInWindow).toBe(0);
  });
});

describe("computeArpuCents", () => {
  it("averages revenue over unique paying businesses", () => {
    const arpu = computeArpuCents({
      subscriptions: [sub()],
      deals: [deal({ monthly_cents: 200_100 })],
      now: NOW
    });
    expect(arpu).toBe(Math.round((STANDARD_MONTHLY + 200_100) / 2));
  });

  it("counts a hybrid payer (subscription + deal on one business) once in the denominator", () => {
    const arpu = computeArpuCents({
      subscriptions: [sub({ business_id: "hybrid" })],
      deals: [deal({ business_id: "hybrid", monthly_cents: 200_100 })],
      now: NOW
    });
    expect(arpu).toBe(STANDARD_MONTHLY + 200_100);
  });

  it("is 0 when nobody pays", () => {
    expect(computeArpuCents({ subscriptions: [], deals: [], now: NOW })).toBe(0);
  });
});

describe("computeTopBusinessRevenue", () => {
  it("ranks businesses by day-current revenue, merging sub + deal rows per business", () => {
    const rows = computeTopBusinessRevenue({
      subscriptions: [
        sub({ business_id: "b1" }),
        // No revenue: pending row and Stripe-less row are skipped.
        sub({ business_id: "b2", status: "pending" }),
        sub({ business_id: "b3", stripe_subscription_id: null })
      ],
      deals: [
        deal({ business_id: "ent-1", monthly_cents: 250_000 }),
        deal({ business_id: "b1", monthly_cents: 1000 }),
        deal({ business_id: "ent-2", status: "canceled", monthly_cents: 999_999 })
      ],
      now: NOW
    });
    expect(rows).toEqual([
      { businessId: "ent-1", cents: 250_000, source: "enterprise_deal" },
      { businessId: "b1", cents: STANDARD_MONTHLY + 1000, source: "subscription" }
    ]);
  });

  it("applies the limit", () => {
    const rows = computeTopBusinessRevenue({
      subscriptions: [sub({ business_id: "b1" }), sub({ business_id: "b2" })],
      deals: [],
      limit: 1,
      now: NOW
    });
    expect(rows).toHaveLength(1);
  });

  it("counts a business with duplicate active rows once (newest wins) — ARPU, top clients, trend", () => {
    const dupes = [
      sub({ business_id: "b1", created_at: "2026-05-01T00:00:00Z" }),
      sub({ business_id: "b1", created_at: "2026-06-01T00:00:00Z" })
    ];
    expect(computeArpuCents({ subscriptions: dupes, deals: [], now: NOW })).toBe(STANDARD_MONTHLY);
    expect(computeTopBusinessRevenue({ subscriptions: dupes, deals: [], now: NOW })).toEqual([
      { businessId: "b1", cents: STANDARD_MONTHLY, source: "subscription" }
    ]);
    const trend = computeMrrTrend({ subscriptions: dupes, deals: [], months: 1, now: NOW });
    expect(trend[0].totalCents).toBe(STANDARD_MONTHLY);
  });
});

describe("listPaymentProblems", () => {
  it("collects past_due rows and payment-failure cancels, newest first", () => {
    const problems = listPaymentProblems([
      sub({ business_id: "ok" }),
      sub({ business_id: "late", status: "past_due", created_at: "2026-07-01T00:00:00Z" }),
      sub({
        business_id: "failed",
        status: "canceled",
        cancel_reason: "payment_failed",
        canceled_at: "2026-07-05T00:00:00Z"
      }),
      sub({
        business_id: "user-cancel",
        status: "canceled",
        cancel_reason: "user_refund",
        canceled_at: "2026-07-06T00:00:00Z"
      }),
      sub({
        business_id: "failed-no-ts",
        status: "canceled",
        cancel_reason: "payment_failed",
        canceled_at: null
      })
    ]);
    expect(problems).toEqual([
      { businessId: "failed", kind: "payment_failed", at: "2026-07-05T00:00:00Z" },
      { businessId: "late", kind: "past_due", at: "2026-07-01T00:00:00Z" },
      { businessId: "failed-no-ts", kind: "payment_failed", at: null }
    ]);
  });

  it("sorts stably when both timestamps are missing", () => {
    const problems = listPaymentProblems([
      sub({ business_id: "n1", status: "canceled", cancel_reason: "payment_failed", canceled_at: null }),
      sub({ business_id: "n2", status: "canceled", cancel_reason: "payment_failed", canceled_at: null })
    ]);
    expect(problems.map((p) => p.businessId)).toEqual(["n1", "n2"]);
  });
});
