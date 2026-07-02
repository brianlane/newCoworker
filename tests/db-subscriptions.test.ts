import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSubscription,
  findCheckoutBlockingSubscription,
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  isCheckoutBlockingSubscription,
  isCommitmentElapsed,
  listSubscriptionsByBusinessIds,
  stripeSubscriptionPeriodCache,
  subscriptionPeriodCacheFromStripe,
  updateSubscription,
  updateSubscriptionIfNotWiped,
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

  it("stripeSubscriptionPeriodCache falls back to items[].current_period (basil API)", () => {
    // Stripe 2025-03-31.basil moved the period fields off the Subscription and
    // onto each SubscriptionItem. Top-level fields are absent on these shapes.
    const start = 1710000000;
    const end = 1712678400;
    const viaItems = stripeSubscriptionPeriodCache({
      items: {
        data: [
          { current_period_start: start, current_period_end: end }
        ]
      }
    });
    expect(viaItems).toMatchObject({
      stripe_current_period_start: new Date(start * 1000).toISOString(),
      stripe_current_period_end: new Date(end * 1000).toISOString()
    });
  });

  it("stripeSubscriptionPeriodCache spans min(start)..max(end) across multi-item subs", () => {
    const viaItems = stripeSubscriptionPeriodCache({
      items: {
        data: [
          { current_period_start: 1720000000, current_period_end: 1722678400 },
          { current_period_start: 1710000000, current_period_end: 1712678400 },
          { current_period_start: 1715000000, current_period_end: 1717678400 }
        ]
      }
    });
    expect(viaItems).toMatchObject({
      stripe_current_period_start: new Date(1710000000 * 1000).toISOString(),
      stripe_current_period_end: new Date(1722678400 * 1000).toISOString()
    });
  });

  it("stripeSubscriptionPeriodCache prefers top-level fields when both shapes are present", () => {
    // Legacy API pinning: keep existing behavior for subs that still return the
    // top-level fields (and any items entries are only used as a fallback).
    const viaBoth = stripeSubscriptionPeriodCache({
      current_period_start: 1700000000,
      current_period_end: 1702678400,
      items: {
        data: [{ current_period_start: 9999999999, current_period_end: 9999999999 }]
      }
    });
    expect(viaBoth).toMatchObject({
      stripe_current_period_start: new Date(1700000000 * 1000).toISOString(),
      stripe_current_period_end: new Date(1702678400 * 1000).toISOString()
    });
  });

  it("stripeSubscriptionPeriodCache returns {} when neither shape has integers", () => {
    expect(stripeSubscriptionPeriodCache({ items: { data: [] } })).toEqual({});
    expect(
      stripeSubscriptionPeriodCache({
        items: { data: [{ current_period_start: "x", current_period_end: 1 }] }
      })
    ).toEqual({});
    // Mirror image of the previous case: a numeric `start` paired with a
    // non-numeric `end` must also yield `{}`. This pins the false branch of
    // the per-item end-type guard (the start-guard false branch is already
    // covered above), so every item-level type check is exercised.
    expect(
      stripeSubscriptionPeriodCache({
        items: { data: [{ current_period_start: 1, current_period_end: "x" }] }
      })
    ).toEqual({});
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

  it("updateSubscriptionIfNotWiped returns updated row when wiped_at IS NULL matches", async () => {
    // Conditional update used by the resubscribe orchestrator's final
    // resurrect-write to avoid silently overwriting a row whose data
    // backup has already been deleted by the grace-sweep cron. The
    // happy path: the predicate matched, the update returned the row.
    const updatedRow = { ...MOCK_SUB, status: "active", wiped_at: null };
    const isFn = vi.fn().mockReturnThis();
    const selectFn = vi.fn().mockResolvedValue({ data: [updatedRow], error: null });
    const db = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: isFn,
      select: selectFn
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await updateSubscriptionIfNotWiped("sub-uuid-1", { status: "active" });
    expect(result).toEqual(updatedRow);
    expect(db.from).toHaveBeenCalledWith("subscriptions");
    expect(db.update).toHaveBeenCalledWith({ status: "active" });
    expect(db.eq).toHaveBeenCalledWith("id", "sub-uuid-1");
    expect(isFn).toHaveBeenCalledWith("wiped_at", null);
  });

  it("updateSubscriptionIfNotWiped returns null when wiped_at IS NOT NULL (grace-sweep raced)", async () => {
    // Race-loss path: the grace-sweep cron stamped wiped_at between
    // the orchestrator's read and this conditional write, so the
    // `wiped_at IS NULL` filter excludes the row and Postgres returns
    // an empty array. The orchestrator uses this null return to abort
    // and cancel the brand-new Stripe sub.
    const db = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await updateSubscriptionIfNotWiped("sub-uuid-1", { status: "active" });
    expect(result).toBeNull();
  });

  it("updateSubscriptionIfNotWiped returns null when data is null (defensive)", async () => {
    // PostgREST has been observed to return `data: null, error: null`
    // for some no-row UPDATE shapes; guard against it explicitly.
    const db = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const result = await updateSubscriptionIfNotWiped("sub-uuid-1", { status: "active" });
    expect(result).toBeNull();
  });

  it("updateSubscriptionIfNotWiped throws on Postgres error", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      updateSubscriptionIfNotWiped("sub-uuid-1", { status: "active" })
    ).rejects.toThrow("updateSubscriptionIfNotWiped: boom");
  });

  it("updateSubscriptionIfNotWiped accepts an injected client (skips createSupabaseServiceClient)", async () => {
    // The optional `client` parameter is part of the public contract
    // of every other db helper in this module; pin it for parity.
    const updatedRow = { ...MOCK_SUB, status: "active" };
    const injected = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [updatedRow], error: null })
    };
    const result = await updateSubscriptionIfNotWiped(
      "sub-uuid-1",
      { status: "active" },
      injected as never
    );
    expect(result).toEqual(updatedRow);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
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

  describe("isCheckoutBlockingSubscription", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    const base = { grace_ends_at: null, wiped_at: null, stripe_subscription_id: null };

    it("blocks on an active subscription", () => {
      expect(
        isCheckoutBlockingSubscription({ ...base, status: "active" as const }, now)
      ).toBe(true);
    });

    it("blocks a canceled subscription still in its data-retention grace window", () => {
      expect(
        isCheckoutBlockingSubscription(
          {
            status: "canceled" as const,
            grace_ends_at: "2026-07-15T00:00:00.000Z",
            wiped_at: null,
            stripe_subscription_id: "sub_x"
          },
          now
        )
      ).toBe(true);
    });

    it("blocks a paid pending row (webhook mid-flight)", () => {
      expect(
        isCheckoutBlockingSubscription(
          { ...base, status: "pending" as const, stripe_subscription_id: "sub_x" },
          now
        )
      ).toBe(true);
    });

    it("allows an unpaid pending row (abandoned checkout stays retryable)", () => {
      expect(
        isCheckoutBlockingSubscription({ ...base, status: "pending" as const }, now)
      ).toBe(false);
    });

    it("allows a fully-canceled subscription past grace (fresh signup ok)", () => {
      expect(
        isCheckoutBlockingSubscription(
          {
            status: "canceled" as const,
            grace_ends_at: "2026-06-01T00:00:00.000Z",
            wiped_at: "2026-06-02T00:00:00.000Z",
            stripe_subscription_id: "sub_x"
          },
          now
        )
      ).toBe(false);
    });
  });

  describe("isCommitmentElapsed", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");

    it("is true for a term plan whose renewal_at has passed", () => {
      expect(
        isCommitmentElapsed(
          { billing_period: "biennial", renewal_at: "2026-06-30T00:00:00.000Z" },
          now
        )
      ).toBe(true);
    });

    it("is true exactly at the boundary", () => {
      expect(
        isCommitmentElapsed(
          { billing_period: "annual", renewal_at: "2026-07-01T00:00:00.000Z" },
          now
        )
      ).toBe(true);
    });

    it("is false while the commitment is still running", () => {
      expect(
        isCommitmentElapsed(
          { billing_period: "biennial", renewal_at: "2027-01-01T00:00:00.000Z" },
          now
        )
      ).toBe(false);
    });

    it("is false for monthly plans (no commitment)", () => {
      expect(
        isCommitmentElapsed(
          { billing_period: "monthly", renewal_at: "2026-01-01T00:00:00.000Z" },
          now
        )
      ).toBe(false);
    });

    it("is false when billing_period or renewal_at is missing/unparseable", () => {
      expect(isCommitmentElapsed({ billing_period: null, renewal_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
      expect(isCommitmentElapsed({ billing_period: "annual", renewal_at: null }, now)).toBe(false);
      expect(isCommitmentElapsed({ billing_period: "annual", renewal_at: "not-a-date" }, now)).toBe(false);
    });
  });

  describe("findCheckoutBlockingSubscription", () => {
    it("returns null for empty input without touching the DB", async () => {
      await expect(findCheckoutBlockingSubscription([])).resolves.toBeNull();
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });

    it("finds a blocking row even when a newer unpaid pending row shadows it", async () => {
      // The Amy incident shape: latest row is the stray unpaid pending, the
      // active row sits underneath. The guard must scan past the pending row.
      const db = {
        ...mockDb(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            { ...MOCK_SUB, id: "sub-pending", status: "pending", stripe_subscription_id: null },
            { ...MOCK_SUB, id: "sub-active", status: "active" }
          ],
          error: null
        })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      const result = await findCheckoutBlockingSubscription(["biz-uuid-1"]);
      expect(result?.id).toBe("sub-active");
    });

    it("returns null when every row is non-blocking", async () => {
      const db = {
        ...mockDb(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [
            { ...MOCK_SUB, id: "sub-pending", status: "pending", stripe_subscription_id: null },
            {
              ...MOCK_SUB,
              id: "sub-old",
              status: "canceled",
              grace_ends_at: "2020-01-01T00:00:00.000Z",
              wiped_at: "2020-01-02T00:00:00.000Z"
            }
          ],
          error: null
        })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(findCheckoutBlockingSubscription(["biz-uuid-1"])).resolves.toBeNull();
    });

    it("returns null when the query returns no rows (data null)", async () => {
      const db = {
        ...mockDb(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: null, error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(findCheckoutBlockingSubscription(["biz-uuid-1"])).resolves.toBeNull();
    });

    it("throws on a query error (fail closed at the checkout gate)", async () => {
      const db = {
        ...mockDb(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(findCheckoutBlockingSubscription(["biz-uuid-1"])).rejects.toThrow(
        "findCheckoutBlockingSubscription: boom"
      );
    });
  });
});
