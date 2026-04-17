import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheLooksValidForQuotaAfterJitFailure,
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
});
