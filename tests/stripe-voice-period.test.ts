import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheLooksValidForQuotaAfterJitFailure,
  STRIPE_CACHE_ABSURD_AGE_MS,
  stripeCacheMaxAgeMs,
  stripeSubscriptionPeriodSeconds,
  subscriptionPeriodNeedsRefresh,
  type SubscriptionPeriodRow
} from "../supabase/functions/_shared/stripe_voice_period";

const baseRow = (over: Partial<SubscriptionPeriodRow>): SubscriptionPeriodRow => ({
  id: "sub-1",
  stripe_subscription_id: "sub_stripe",
  stripe_current_period_start: "2026-04-01T00:00:00.000Z",
  stripe_current_period_end: "2026-05-01T00:00:00.000Z",
  stripe_subscription_cached_at: "2026-04-10T12:00:00.000Z",
  ...over
});

describe("stripe_voice_period (§4.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscriptionPeriodNeedsRefresh is false when cache fresh and inside period", () => {
    const row = baseRow({
      stripe_subscription_cached_at: "2026-04-15T11:00:00.000Z"
    });
    expect(subscriptionPeriodNeedsRefresh(row, "sk_test")).toBe(false);
  });

  it("subscriptionPeriodNeedsRefresh when cached_at missing", () => {
    const row = baseRow({ stripe_subscription_cached_at: null });
    expect(subscriptionPeriodNeedsRefresh(row, "sk_test")).toBe(true);
  });

  it("cacheLooksValidForQuotaAfterJitFailure true when inside period with sane cache age", () => {
    const row = baseRow({
      stripe_subscription_cached_at: "2026-04-15T11:00:00.000Z"
    });
    const now = new Date("2026-04-15T12:00:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now)).toBe(true);
  });

  it("cacheLooksValidForQuotaAfterJitFailure false past period end + buffer", () => {
    const row = baseRow({});
    const now = new Date("2026-05-01T00:20:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now)).toBe(false);
  });

  it("cacheLooksValidForQuotaAfterJitFailure false when cached_at null", () => {
    const row = baseRow({ stripe_subscription_cached_at: null });
    const now = new Date("2026-04-15T12:00:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now)).toBe(false);
  });

  it("subscriptionPeriodNeedsRefresh false without Stripe secret or subscription id", () => {
    expect(subscriptionPeriodNeedsRefresh(baseRow({}), "")).toBe(false);
    expect(subscriptionPeriodNeedsRefresh(baseRow({ stripe_subscription_id: null }), "sk_test")).toBe(false);
  });

  it("subscriptionPeriodNeedsRefresh true when period bounds missing", () => {
    const row = baseRow({
      stripe_current_period_start: null,
      stripe_subscription_cached_at: "2026-04-15T11:00:00.000Z"
    });
    expect(subscriptionPeriodNeedsRefresh(row, "sk_test")).toBe(true);
  });

  it("subscriptionPeriodNeedsRefresh true when cache older than TTL", () => {
    const row = baseRow({
      stripe_subscription_cached_at: "2026-04-14T00:00:00.000Z"
    });
    expect(subscriptionPeriodNeedsRefresh(row, "sk_test")).toBe(true);
  });

  it("subscriptionPeriodNeedsRefresh true past period end grace", () => {
    const row = baseRow({
      stripe_current_period_start: "2026-03-01T00:00:00.000Z",
      stripe_current_period_end: "2026-04-01T00:00:00.000Z",
      stripe_subscription_cached_at: "2026-04-15T11:00:00.000Z"
    });
    expect(subscriptionPeriodNeedsRefresh(row, "sk_test")).toBe(true);
  });

  it("cacheLooksValidForQuotaAfterJitFailure false without period bounds", () => {
    const row = baseRow({ stripe_current_period_start: null });
    expect(cacheLooksValidForQuotaAfterJitFailure(row, Date.now())).toBe(false);
  });

  it("cacheLooksValidForQuotaAfterJitFailure false when cache absurdly old", () => {
    const row = baseRow({
      stripe_subscription_cached_at: "2025-01-01T00:00:00.000Z"
    });
    const now = new Date("2026-04-15T12:00:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now)).toBe(false);
  });

  it("stripeCacheMaxAgeMs widens only for prepaid term plans", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(stripeCacheMaxAgeMs("monthly")).toBe(STRIPE_CACHE_ABSURD_AGE_MS);
    expect(stripeCacheMaxAgeMs(null)).toBe(STRIPE_CACHE_ABSURD_AGE_MS);
    expect(stripeCacheMaxAgeMs(undefined)).toBe(STRIPE_CACHE_ABSURD_AGE_MS);
    expect(stripeCacheMaxAgeMs("something-new")).toBe(STRIPE_CACHE_ABSURD_AGE_MS);
    expect(stripeCacheMaxAgeMs("annual")).toBe(STRIPE_CACHE_ABSURD_AGE_MS + 365 * DAY);
    expect(stripeCacheMaxAgeMs("biennial")).toBe(STRIPE_CACHE_ABSURD_AGE_MS + 730 * DAY);
  });

  it("cacheLooksValidForQuotaAfterJitFailure honors a year-old cache on a biennial plan", () => {
    // Amy Laidlaw Real Estate, Aug 2026: prepaid biennial through 2028, cache
    // last stamped on purchase day. The monthly yardstick refused her calls
    // 30 days later even though the tenant was paid in full.
    const row = baseRow({
      stripe_current_period_start: "2026-04-01T00:00:00.000Z",
      stripe_current_period_end: "2028-04-01T00:00:00.000Z",
      stripe_subscription_cached_at: "2026-04-01T00:00:00.000Z"
    });
    const now = new Date("2027-01-01T00:00:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now, "biennial")).toBe(true);
    expect(cacheLooksValidForQuotaAfterJitFailure(row, now, "monthly")).toBe(false);
    // A term cache past even the widened cap is still refused.
    const wayLater = new Date("2029-01-01T00:00:00.000Z").getTime();
    expect(cacheLooksValidForQuotaAfterJitFailure(row, wayLater, "biennial")).toBe(false);
  });
});

describe("stripeSubscriptionPeriodSeconds", () => {
  it("reads the per-item shape returned by basil and later", () => {
    expect(
      stripeSubscriptionPeriodSeconds({
        items: { data: [{ current_period_start: 1785278522, current_period_end: 1848436922 }] }
      })
    ).toEqual({ start: 1785278522, end: 1848436922 });
  });

  it("spans every item as [min(start), max(end)]", () => {
    expect(
      stripeSubscriptionPeriodSeconds({
        items: {
          data: [
            { current_period_start: 1720000000, current_period_end: 1722678400 },
            { current_period_start: 1710000000, current_period_end: 1712678400 },
            { current_period_start: 1715000000, current_period_end: 1717678400 }
          ]
        }
      })
    ).toEqual({ start: 1710000000, end: 1722678400 });
  });

  it("prefers the legacy top-level shape when present", () => {
    expect(
      stripeSubscriptionPeriodSeconds({
        current_period_start: 1700000000,
        current_period_end: 1702678400,
        items: { data: [{ current_period_start: 9999999999, current_period_end: 9999999999 }] }
      })
    ).toEqual({ start: 1700000000, end: 1702678400 });
  });

  it("falls through to items when the top-level fields are not both numbers", () => {
    expect(
      stripeSubscriptionPeriodSeconds({
        current_period_start: "nope",
        current_period_end: 1702678400,
        items: { data: [{ current_period_start: 1, current_period_end: 2 }] }
      })
    ).toEqual({ start: 1, end: 2 });
    expect(
      stripeSubscriptionPeriodSeconds({
        current_period_start: Number.NaN,
        current_period_end: Number.NaN,
        items: { data: [{ current_period_start: 3, current_period_end: 4 }] }
      })
    ).toEqual({ start: 3, end: 4 });
  });

  it("returns null for anything that carries no period on either shape", () => {
    expect(stripeSubscriptionPeriodSeconds(null)).toBeNull();
    expect(stripeSubscriptionPeriodSeconds(undefined)).toBeNull();
    expect(stripeSubscriptionPeriodSeconds("sub_123")).toBeNull();
    expect(stripeSubscriptionPeriodSeconds({})).toBeNull();
    expect(stripeSubscriptionPeriodSeconds({ items: { data: [] } })).toBeNull();
    expect(stripeSubscriptionPeriodSeconds({ current_period_start: "nope" })).toBeNull();
    expect(
      stripeSubscriptionPeriodSeconds({ items: { data: [{ current_period_start: 1 }] } })
    ).toBeNull();
    expect(
      stripeSubscriptionPeriodSeconds({ items: { data: [{ current_period_end: 2 }] } })
    ).toBeNull();
  });
});
