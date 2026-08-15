import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

import { resolvePaidThroughForBillingSub } from "@/lib/hostinger/paid-through";
import type { BillingSubscription } from "@/lib/hostinger/client";

function sub(overrides: Partial<BillingSubscription> & { id: string }): BillingSubscription {
  return { ...overrides } as BillingSubscription;
}

function lister(subs: BillingSubscription[]) {
  return { listBillingSubscriptions: vi.fn(async () => subs) };
}

describe("resolvePaidThroughForBillingSub", () => {
  it("returns expires_at for the matching subscription", async () => {
    const client = lister([
      sub({ id: "other", expires_at: "2027-01-01T00:00:00Z" }),
      sub({ id: "sub-1", expires_at: "2028-07-01T00:00:00Z" })
    ]);
    await expect(resolvePaidThroughForBillingSub(client, "sub-1")).resolves.toBe(
      "2028-07-01T00:00:00Z"
    );
  });

  // paidThroughFromBillingSub prefers expires_at and falls back to
  // next_billing_at; a monthly box typically only carries the latter.
  it("falls back to next_billing_at when expires_at is absent", async () => {
    const client = lister([sub({ id: "sub-1", next_billing_at: "2026-09-14T11:01:08Z" })]);
    await expect(resolvePaidThroughForBillingSub(client, "sub-1")).resolves.toBe(
      "2026-09-14T11:01:08Z"
    );
  });

  it("returns null without calling Hostinger when there is no billing id", async () => {
    const client = lister([]);
    await expect(resolvePaidThroughForBillingSub(client, null)).resolves.toBeNull();
    await expect(resolvePaidThroughForBillingSub(client, undefined)).resolves.toBeNull();
    await expect(resolvePaidThroughForBillingSub(client, "")).resolves.toBeNull();
    expect(client.listBillingSubscriptions).not.toHaveBeenCalled();
  });

  it("returns null when the subscription is not in the list", async () => {
    const client = lister([sub({ id: "someone-else", expires_at: "2028-01-01T00:00:00Z" })]);
    await expect(resolvePaidThroughForBillingSub(client, "sub-1")).resolves.toBeNull();
  });

  it("returns null when Hostinger reports neither expiry field", async () => {
    const client = lister([sub({ id: "sub-1" })]);
    await expect(resolvePaidThroughForBillingSub(client, "sub-1")).resolves.toBeNull();
  });

  // The contract the callers rely on: this never throws, because it runs
  // inside a signup and inside a cancel, and neither may fail over pool
  // bookkeeping.
  it("swallows a Hostinger failure and returns null", async () => {
    const client = {
      listBillingSubscriptions: vi.fn(async () => {
        throw new Error("hostinger 503");
      })
    };
    await expect(resolvePaidThroughForBillingSub(client, "sub-1")).resolves.toBeNull();
  });

  it("swallows a non-Error rejection", async () => {
    const client = {
      listBillingSubscriptions: vi.fn(async () => {
        throw "string blowup";
      })
    };
    await expect(
      resolvePaidThroughForBillingSub(client, "sub-1", { businessId: "biz-1" })
    ).resolves.toBeNull();
  });
});
