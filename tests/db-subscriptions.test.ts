import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSubscription,
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  listSubscriptionsByBusinessIds,
  stripeSubscriptionPeriodCache,
  subscriptionPeriodCacheFromStripe,
  updateSubscription,
  type SubscriptionPeriodStripeCache
} from "@/lib/db/subscriptions";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_SUB = {
  id: "sub-uuid-1",
  business_id: "biz-uuid-1",
  stripe_customer_id: "cus_mock",
  stripe_subscription_id: "sub_mock",
  tier: "starter",
  status: "active",
  created_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK_SUB, error: null }),
    ...overrides
  };
}

describe("db/subscriptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("subscriptionPeriodCacheFromStripe maps Stripe epoch seconds to ISO cache fields", () => {
    const row = subscriptionPeriodCacheFromStripe({
      current_period_start: 1700000000,
      current_period_end: 1702678400
    });
    expect(row.stripe_current_period_start).toBe(new Date(1700000000 * 1000).toISOString());
    expect(row.stripe_current_period_end).toBe(new Date(1702678400 * 1000).toISOString());
    expect(row.stripe_subscription_cached_at).toMatch(/^\d{4}-/);
  });

  it("stripeSubscriptionPeriodCache returns {} when period fields are missing or wrong type", () => {
    expect(stripeSubscriptionPeriodCache({})).toEqual({});
    expect(stripeSubscriptionPeriodCache({ current_period_start: "x", current_period_end: 1 })).toEqual({});
    expect(stripeSubscriptionPeriodCache(null)).toEqual({});
  });

  it("stripeSubscriptionPeriodCache delegates when both periods are numbers", () => {
    const start = 1700000000;
    const end = 1702678400;
    const viaCache = stripeSubscriptionPeriodCache({ current_period_start: start, current_period_end: end });
    expect(viaCache).toMatchObject({
      stripe_current_period_start: new Date(start * 1000).toISOString(),
      stripe_current_period_end: new Date(end * 1000).toISOString()
    });
    expect(viaCache).toHaveProperty("stripe_subscription_cached_at");
    expect(typeof (viaCache as SubscriptionPeriodStripeCache).stripe_subscription_cached_at).toBe("string");
  });

  it("createSubscription inserts and returns row", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await createSubscription({
      id: "sub-uuid-1",
      business_id: "biz-uuid-1",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: "starter",
      status: "pending"
    });
    expect(result.tier).toBe("starter");
  });

  it("createSubscription throws on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(createSubscription({
      id: "x",
      business_id: "y",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: "starter",
      status: "pending"
    })).rejects.toThrow("createSubscription");
  });

  it("getSubscription returns subscription", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_SUB, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getSubscription("biz-uuid-1");
    expect(result?.status).toBe("active");
  });

  it("getSubscription returns null on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "nf" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getSubscription("bad");
    expect(result).toBeNull();
  });

  it("getSubscriptionByStripeSubscriptionId returns subscription", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: MOCK_SUB, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getSubscriptionByStripeSubscriptionId("sub_mock");
    expect(result?.stripe_subscription_id).toBe("sub_mock");
  });

  it("getSubscriptionByStripeSubscriptionId returns null on error", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: null, error: { message: "nf" } }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await getSubscriptionByStripeSubscriptionId("bad_sub");
    expect(result).toBeNull();
  });

  it("updateSubscription calls update with patch", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const db = { ...mockDb(), eq: eqFn };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateSubscription("sub-uuid-1", { status: "canceled" });
    expect(db.update).toHaveBeenCalledWith({ status: "canceled" });
  });

  it("updateSubscription throws on error", async () => {
    const db = { ...mockDb(), eq: vi.fn().mockResolvedValue({ error: { message: "fail" } }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateSubscription("sub-uuid-1", { status: "active" })).rejects.toThrow("updateSubscription");
  });

  it("listSubscriptionsByBusinessIds returns an empty map for empty input", async () => {
    const result = await listSubscriptionsByBusinessIds([]);
    expect(result.size).toBe(0);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("listSubscriptionsByBusinessIds keeps the newest row per business", async () => {
    const db = {
      ...mockDb(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          { ...MOCK_SUB, id: "sub-new", business_id: "biz-uuid-1" },
          { ...MOCK_SUB, id: "sub-old", business_id: "biz-uuid-1" },
          { ...MOCK_SUB, id: "sub-2", business_id: "biz-uuid-2" }
        ],
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await listSubscriptionsByBusinessIds(["biz-uuid-1", "biz-uuid-2"]);
    expect(result.get("biz-uuid-1")?.id).toBe("sub-new");
    expect(result.get("biz-uuid-2")?.id).toBe("sub-2");
  });

  it("listSubscriptionsByBusinessIds throws on query error", async () => {
    const db = {
      ...mockDb(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listSubscriptionsByBusinessIds(["biz-uuid-1"])).rejects.toThrow(
      "listSubscriptionsByBusinessIds"
    );
  });

  it("listSubscriptionsByBusinessIds returns an empty map when data is null", async () => {
    const db = {
      ...mockDb(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await listSubscriptionsByBusinessIds(["biz-uuid-1"]);
    expect(result.size).toBe(0);
  });
});
