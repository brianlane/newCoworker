import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  startPrioritySupport,
  cancelPrioritySupport,
  terminatePrioritySupport,
  isPrioritySupportSubscription,
  prioritySupportPeriodEnd,
  recordPrioritySupportCheckout,
  applyPrioritySupportInvoicePaid
} from "@/lib/billing/priority-support";

const BIZ = "0f0f0f0f-0000-4000-8000-0000000000bb";

const LIVE_ROW = {
  id: "row-1",
  business_id: BIZ,
  stripe_subscription_id: "sub_priority_1",
  stripe_customer_id: "cus_1",
  stripe_session_id: "cs_1",
  status: "active" as const,
  started_at: "2026-08-17T00:00:00Z",
  current_period_end: "2026-09-17T00:00:00Z",
  cancel_at_period_end: false,
  canceled_at: null,
  created_by: "owner@test.com",
  created_at: "2026-08-17T00:00:00Z"
};

const ACTIVE_MEMBERSHIP = {
  id: "membership-1",
  business_id: BIZ,
  status: "active",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_membership_1"
};

function stripeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_priority_1",
    metadata: { subscriptionKind: "priority_support", businessId: BIZ },
    cancel_at_period_end: false,
    current_period_end: Math.floor(new Date("2026-09-17T00:00:00Z").getTime() / 1000),
    ...overrides
  } as unknown as Stripe.Subscription;
}

describe("startPrioritySupport", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    businessId: BIZ,
    tier: "standard",
    actorEmail: "owner@test.com",
    userId: "user-1",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no"
  };

  it("returns a checkout url for an eligible tenant", async () => {
    const createCheckout = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.test/1" });
    const res = await startPrioritySupport(base, {
      getLiveRow: vi.fn().mockResolvedValue(null),
      getSubscriptionRow: vi.fn().mockResolvedValue(ACTIVE_MEMBERSHIP as never),
      createCheckout
    });
    expect(res).toEqual({ ok: true, value: { checkoutUrl: "https://pay.test/1" } });
    // The add-on must land on the membership's EXISTING Stripe customer, not
    // open a second customer record for the same business.
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ, customerId: "cus_1", userId: "user-1" })
    );
  });

  it("passes an email instead when the membership has no Stripe customer yet", async () => {
    const createCheckout = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.test/1" });
    await startPrioritySupport(base, {
      getLiveRow: vi.fn().mockResolvedValue(null),
      getSubscriptionRow: vi
        .fn()
        .mockResolvedValue({ ...ACTIVE_MEMBERSHIP, stripe_customer_id: null } as never),
      createCheckout
    });
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: undefined, customerEmail: "owner@test.com" })
    );
  });

  it("omits userId when an admin generates the link", async () => {
    const createCheckout = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.test/1" });
    const { userId: _drop, ...noUser } = base;
    await startPrioritySupport(noUser, {
      getLiveRow: vi.fn().mockResolvedValue(null),
      getSubscriptionRow: vi.fn().mockResolvedValue(ACTIVE_MEMBERSHIP as never),
      createCheckout
    });
    expect(createCheckout).toHaveBeenCalledWith(
      expect.not.objectContaining({ userId: expect.anything() })
    );
  });

  it("refuses enterprise, who already hold a permanent window", async () => {
    const createCheckout = vi.fn();
    const res = await startPrioritySupport(
      { ...base, tier: "enterprise" },
      { getLiveRow: vi.fn(), getSubscriptionRow: vi.fn(), createCheckout }
    );
    expect(res).toEqual({ ok: false, reason: "not_purchasable_for_tier" });
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("refuses a tenant who already has a live subscription", async () => {
    const createCheckout = vi.fn();
    const res = await startPrioritySupport(base, {
      getLiveRow: vi.fn().mockResolvedValue(LIVE_ROW as never),
      getSubscriptionRow: vi.fn(),
      createCheckout
    });
    expect(res).toEqual({ ok: false, reason: "already_subscribed" });
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("refuses when there is no active membership", async () => {
    const createCheckout = vi.fn();
    for (const membership of [null, { ...ACTIVE_MEMBERSHIP, status: "canceled" }]) {
      const res = await startPrioritySupport(base, {
        getLiveRow: vi.fn().mockResolvedValue(null),
        getSubscriptionRow: vi.fn().mockResolvedValue(membership as never),
        createCheckout
      });
      expect(res).toEqual({ ok: false, reason: "no_active_membership" });
    }
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe("cancelPrioritySupport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("winds down at period end and mirrors the row", async () => {
    const cancelSubscription = vi.fn().mockResolvedValue({});
    const mirror = vi.fn().mockResolvedValue(undefined);
    const res = await cancelPrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue(LIVE_ROW as never),
      cancelSubscription,
      mirror
    });
    expect(res).toEqual({ ok: true, value: { coverageEndsAt: "2026-09-17T00:00:00Z" } });
    expect(cancelSubscription).toHaveBeenCalledWith("sub_priority_1");
    expect(mirror).toHaveBeenCalledWith("sub_priority_1", {
      status: "canceling",
      currentPeriodEnd: new Date("2026-09-17T00:00:00Z"),
      cancelAtPeriodEnd: true
    });
  });

  it("tolerates a row with no cached period end", async () => {
    const mirror = vi.fn().mockResolvedValue(undefined);
    const res = await cancelPrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue({ ...LIVE_ROW, current_period_end: null } as never),
      cancelSubscription: vi.fn().mockResolvedValue({}),
      mirror
    });
    expect(res).toEqual({ ok: true, value: { coverageEndsAt: null } });
    expect(mirror).toHaveBeenCalledWith(
      "sub_priority_1",
      expect.objectContaining({ currentPeriodEnd: null })
    );
  });

  it("reports not_subscribed when there is nothing to cancel", async () => {
    const cancelSubscription = vi.fn();
    const res = await cancelPrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue(null),
      cancelSubscription,
      mirror: vi.fn()
    });
    expect(res).toEqual({ ok: false, reason: "not_subscribed" });
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});

describe("terminatePrioritySupport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels outright and marks the row, so a dead tenant stops being billed", async () => {
    const cancelStripe = vi.fn().mockResolvedValue(undefined);
    const markCanceled = vi.fn().mockResolvedValue(undefined);
    const did = await terminatePrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue(LIVE_ROW as never),
      cancelStripe,
      markCanceled,
      now: () => new Date("2026-08-20T00:00:00Z")
    });
    expect(did).toBe(true);
    expect(cancelStripe).toHaveBeenCalledWith("sub_priority_1", BIZ);
    expect(markCanceled).toHaveBeenCalledWith(
      "sub_priority_1",
      new Date("2026-08-20T00:00:00Z")
    );
  });

  it("is a no-op when the tenant never had it", async () => {
    const cancelStripe = vi.fn();
    const did = await terminatePrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue(null),
      cancelStripe,
      markCanceled: vi.fn()
    });
    expect(did).toBe(false);
    expect(cancelStripe).not.toHaveBeenCalled();
  });

  it("swallows its own errors: teardown callers must never be aborted by it", async () => {
    const did = await terminatePrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockRejectedValue(new Error("db down")),
      cancelStripe: vi.fn(),
      markCanceled: vi.fn()
    });
    expect(did).toBe(false);
  });

  it("swallows a non-Error rejection too", async () => {
    const did = await terminatePrioritySupport(BIZ, {
      getLiveRow: vi.fn().mockResolvedValue(LIVE_ROW as never),
      cancelStripe: vi.fn().mockRejectedValue("stripe exploded"),
      markCanceled: vi.fn()
    });
    expect(did).toBe(false);
  });
});

describe("isPrioritySupportSubscription", () => {
  it("recognizes the marker the webhook gates on", () => {
    expect(isPrioritySupportSubscription(stripeSub())).toBe(true);
  });

  it("is false for the membership subscription and for missing metadata", () => {
    expect(isPrioritySupportSubscription(stripeSub({ metadata: { businessId: BIZ } }))).toBe(
      false
    );
    expect(isPrioritySupportSubscription(stripeSub({ metadata: {} }))).toBe(false);
    expect(isPrioritySupportSubscription(null)).toBe(false);
    expect(isPrioritySupportSubscription(undefined)).toBe(false);
  });
});

describe("prioritySupportPeriodEnd", () => {
  it("reads the top-level shape", () => {
    expect(prioritySupportPeriodEnd(stripeSub())?.toISOString()).toBe(
      "2026-09-17T00:00:00.000Z"
    );
  });

  it("falls back to the per-item shape Stripe moved to", () => {
    const sub = stripeSub({
      current_period_end: null,
      items: {
        data: [{ current_period_end: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000) }]
      }
    });
    expect(prioritySupportPeriodEnd(sub)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("returns null when neither shape carries a usable value", () => {
    expect(prioritySupportPeriodEnd(stripeSub({ current_period_end: null }))).toBeNull();
    expect(
      prioritySupportPeriodEnd(stripeSub({ current_period_end: Number.NaN }))
    ).toBeNull();
    expect(
      prioritySupportPeriodEnd(
        stripeSub({ current_period_end: null, items: { data: [{}] } })
      )
    ).toBeNull();
  });
});

describe("recordPrioritySupportCheckout", () => {
  beforeEach(() => vi.clearAllMocks());

  const input = {
    businessId: BIZ,
    stripeSubscriptionId: "sub_priority_1",
    stripeCustomerId: "cus_1",
    stripeSessionId: "cs_1",
    periodEnd: new Date("2026-09-17T00:00:00Z"),
    createdBy: "owner@test.com"
  };

  it("records the row and opens coverage at period end plus grace", async () => {
    const record = vi.fn().mockResolvedValue({ row: LIVE_ROW, duplicate: false });
    const extend = vi.fn().mockResolvedValue(undefined);
    const clearNudge = vi.fn().mockResolvedValue(undefined);
    const res = await recordPrioritySupportCheckout(input, { record, extend, clearNudge });
    expect(res).toEqual({ duplicate: false });
    // 3 days of slack past the period end.
    expect(extend).toHaveBeenCalledWith(BIZ, new Date("2026-09-20T00:00:00Z"));
    // A tenant who lapsed and restarted must be warnable again.
    expect(clearNudge).toHaveBeenCalledWith(BIZ);
  });

  it("still records the row when Stripe gave no period end", async () => {
    const record = vi.fn().mockResolvedValue({ row: LIVE_ROW, duplicate: false });
    const extend = vi.fn();
    const clearNudge = vi.fn();
    await recordPrioritySupportCheckout({ ...input, periodEnd: null }, {
      record,
      extend,
      clearNudge
    });
    expect(record).toHaveBeenCalled();
    // The next paid invoice stamps coverage from the live period end instead.
    expect(extend).not.toHaveBeenCalled();
    expect(clearNudge).not.toHaveBeenCalled();
  });

  it("reports a duplicate from a replayed webhook", async () => {
    const res = await recordPrioritySupportCheckout(input, {
      record: vi.fn().mockResolvedValue({ row: LIVE_ROW, duplicate: true }),
      extend: vi.fn().mockResolvedValue(undefined),
      clearNudge: vi.fn().mockResolvedValue(undefined)
    });
    expect(res).toEqual({ duplicate: true });
  });
});

describe("applyPrioritySupportInvoicePaid", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extends coverage from the period end and mirrors the row", async () => {
    const extend = vi.fn().mockResolvedValue(undefined);
    const mirror = vi.fn().mockResolvedValue(undefined);
    const clearNudge = vi.fn().mockResolvedValue(undefined);
    const ok = await applyPrioritySupportInvoicePaid(
      { businessId: BIZ, stripeSubscription: stripeSub() },
      { extend, mirror, clearNudge }
    );
    expect(ok).toBe(true);
    expect(extend).toHaveBeenCalledWith(BIZ, new Date("2026-09-20T00:00:00Z"));
    expect(mirror).toHaveBeenCalledWith("sub_priority_1", {
      status: "active",
      currentPeriodEnd: new Date("2026-09-17T00:00:00Z"),
      cancelAtPeriodEnd: false
    });
    expect(clearNudge).toHaveBeenCalledWith(BIZ);
  });

  it("mirrors a winding-down subscription as canceling", async () => {
    const mirror = vi.fn().mockResolvedValue(undefined);
    await applyPrioritySupportInvoicePaid(
      { businessId: BIZ, stripeSubscription: stripeSub({ cancel_at_period_end: true }) },
      { extend: vi.fn().mockResolvedValue(undefined), mirror, clearNudge: vi.fn().mockResolvedValue(undefined) }
    );
    expect(mirror).toHaveBeenCalledWith(
      "sub_priority_1",
      expect.objectContaining({ status: "canceling", cancelAtPeriodEnd: true })
    );
  });

  it("does nothing when the period end cannot be resolved", async () => {
    const extend = vi.fn();
    const ok = await applyPrioritySupportInvoicePaid(
      {
        businessId: BIZ,
        stripeSubscription: stripeSub({ current_period_end: null })
      },
      { extend, mirror: vi.fn(), clearNudge: vi.fn() }
    );
    expect(ok).toBe(false);
    expect(extend).not.toHaveBeenCalled();
  });
});
