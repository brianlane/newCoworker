import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getLivePrioritySupportSubscription,
  getPrioritySupportSubscriptionByStripeId,
  recordPrioritySupportSubscription,
  mirrorPrioritySupportSubscription,
  markPrioritySupportSubscriptionCanceled
} from "@/lib/db/priority-support";

const BIZ = "0f0f0f0f-0000-4000-8000-0000000000bb";

const ROW = {
  id: "0f0f0f0f-0000-4000-8000-000000000001",
  business_id: BIZ,
  stripe_subscription_id: "sub_priority_1",
  stripe_customer_id: "cus_1",
  stripe_session_id: "cs_1",
  status: "active",
  started_at: "2026-08-17T00:00:00Z",
  current_period_end: "2026-09-17T00:00:00Z",
  cancel_at_period_end: false,
  canceled_at: null,
  created_by: "owner@test.com",
  created_at: "2026-08-17T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

describe("db/priority-support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getLivePrioritySupportSubscription", () => {
    it("returns the row and excludes canceled history", async () => {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: ROW, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const row = await getLivePrioritySupportSubscription(BIZ);
      expect(row).toEqual(ROW);
      expect(db.eq).toHaveBeenCalledWith("business_id", BIZ);
      // A canceled row is history: never returned, so "can this tenant buy it"
      // stays a single call.
      expect(db.neq).toHaveBeenCalledWith("status", "canceled");
    });

    it("returns null when the tenant has none", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getLivePrioritySupportSubscription(BIZ)).toBeNull();
    });

    it("throws on a read error", async () => {
      const db = mockDb({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getLivePrioritySupportSubscription(BIZ)).rejects.toThrow(/boom/);
    });

    it("uses an injected client when given one", async () => {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: ROW, error: null }) });
      await getLivePrioritySupportSubscription(BIZ, db as never);
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });
  });

  describe("getPrioritySupportSubscriptionByStripeId", () => {
    it("looks up by the Stripe subscription id", async () => {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: ROW, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getPrioritySupportSubscriptionByStripeId("sub_priority_1")).toEqual(ROW);
      expect(db.eq).toHaveBeenCalledWith("stripe_subscription_id", "sub_priority_1");
    });

    it("returns null when absent", async () => {
      const db = mockDb();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getPrioritySupportSubscriptionByStripeId("sub_missing")).toBeNull();
    });

    it("throws on a read error", async () => {
      const db = mockDb({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getPrioritySupportSubscriptionByStripeId("sub_1")).rejects.toThrow(/nope/);
    });
  });

  describe("recordPrioritySupportSubscription", () => {
    const input = {
      businessId: BIZ,
      stripeSubscriptionId: "sub_priority_1",
      stripeCustomerId: "cus_1",
      stripeSessionId: "cs_1",
      currentPeriodEnd: new Date("2026-09-17T00:00:00Z"),
      createdBy: "owner@test.com"
    };

    it("inserts and reports a fresh row", async () => {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: ROW, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const res = await recordPrioritySupportSubscription(input);
      expect(res).toEqual({ row: ROW, duplicate: false });
      expect(db.insert).toHaveBeenCalledWith({
        business_id: BIZ,
        stripe_subscription_id: "sub_priority_1",
        stripe_customer_id: "cus_1",
        stripe_session_id: "cs_1",
        current_period_end: "2026-09-17T00:00:00.000Z",
        created_by: "owner@test.com"
      });
    });

    it("writes a null period end when Stripe gave us none", async () => {
      const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: ROW, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await recordPrioritySupportSubscription({ ...input, currentPeriodEnd: null });
      expect(db.insert).toHaveBeenCalledWith(
        expect.objectContaining({ current_period_end: null })
      );
    });

    it("resolves a unique violation to the existing row instead of throwing", async () => {
      // A Stripe retry must not become a 500 that Stripe retries again.
      const maybeSingle = vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dupe" } })
        .mockResolvedValueOnce({ data: ROW, error: null });
      const db = mockDb({ maybeSingle });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const res = await recordPrioritySupportSubscription(input);
      expect(res).toEqual({ row: ROW, duplicate: true });
    });

    it("falls back to the tenant's live row when the conflict was the one-live index", async () => {
      // The partial unique index fires when a DIFFERENT subscription id is
      // inserted for a business that already has one, so the by-stripe-id
      // lookup misses and the by-business lookup is what resolves it.
      const maybeSingle = vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dupe" } })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: ROW, error: null });
      const db = mockDb({ maybeSingle });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const res = await recordPrioritySupportSubscription({
        ...input,
        stripeSubscriptionId: "sub_priority_2"
      });
      expect(res).toEqual({ row: ROW, duplicate: true });
    });

    it("throws when a conflict resolves to nothing", async () => {
      const maybeSingle = vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dupe" } })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: null });
      const db = mockDb({ maybeSingle });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(recordPrioritySupportSubscription(input)).rejects.toThrow(
        /conflict with no resolvable row/
      );
    });

    it("throws on a non-conflict insert error", async () => {
      const db = mockDb({
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(recordPrioritySupportSubscription(input)).rejects.toThrow(/denied/);
    });
  });

  describe("mirrorPrioritySupportSubscription", () => {
    it("mirrors status, period end, and the renewal flag", async () => {
      const db = mockDb({ eq: vi.fn().mockResolvedValue({ error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await mirrorPrioritySupportSubscription("sub_priority_1", {
        status: "canceling",
        currentPeriodEnd: new Date("2026-09-17T00:00:00Z"),
        cancelAtPeriodEnd: true
      });
      expect(db.update).toHaveBeenCalledWith({
        status: "canceling",
        current_period_end: "2026-09-17T00:00:00.000Z",
        cancel_at_period_end: true
      });
    });

    it("stamps canceled_at only on the terminal status", async () => {
      const db = mockDb({ eq: vi.fn().mockResolvedValue({ error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await mirrorPrioritySupportSubscription("sub_priority_1", {
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false
      });
      expect(db.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "canceled", canceled_at: expect.any(String) })
      );
    });

    it("throws on a write error", async () => {
      const db = mockDb({ eq: vi.fn().mockResolvedValue({ error: { message: "bad" } }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(
        mirrorPrioritySupportSubscription("sub_1", {
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false
        })
      ).rejects.toThrow(/bad/);
    });
  });

  describe("markPrioritySupportSubscriptionCanceled", () => {
    it("clears the renewal flag alongside the terminal status", async () => {
      const db = mockDb({ eq: vi.fn().mockResolvedValue({ error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await markPrioritySupportSubscriptionCanceled(
        "sub_priority_1",
        new Date("2026-08-20T00:00:00Z")
      );
      expect(db.update).toHaveBeenCalledWith({
        status: "canceled",
        cancel_at_period_end: false,
        canceled_at: "2026-08-20T00:00:00.000Z"
      });
    });

    it("throws on a write error", async () => {
      const db = mockDb({ eq: vi.fn().mockResolvedValue({ error: { message: "kaput" } }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(
        markPrioritySupportSubscriptionCanceled("sub_1", new Date())
      ).rejects.toThrow(/kaput/);
    });
  });
});
