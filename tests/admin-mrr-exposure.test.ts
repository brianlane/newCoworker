import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  stampRefundExposure,
  stampRefundExposureFromDb,
  type RefundExposureSubscription
} from "@/lib/admin/mrr-exposure";
import { listCustomerProfilesByIds } from "@/lib/db/customer-profiles";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NOW = new Date("2026-07-10T12:00:00Z");

function sub(
  overrides: Partial<RefundExposureSubscription> = {}
): RefundExposureSubscription {
  return {
    business_id: "biz-1",
    customer_profile_id: "prof-1",
    tier: "standard",
    status: "active",
    stripe_subscription_id: "sub_123",
    billing_period: "monthly",
    renewal_at: null,
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    created_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

/** Profile whose 30-day window is open (paid 5 days before NOW, unused). */
const OPEN_PROFILE = { first_paid_at: "2026-07-05T00:00:00Z", refund_used_at: null };

describe("stampRefundExposure", () => {
  it("marks a hostinger-placement subscription with an open refund window as exposed", () => {
    const [stamped] = stampRefundExposure([sub()], {
      profilesById: new Map([["prof-1", OPEN_PROFILE]]),
      vpsProviderByBusinessId: new Map([["biz-1", "hostinger"]]),
      now: NOW
    });
    expect(stamped.refund_exposed).toBe(true);
  });

  it("treats a missing provider entry as hostinger (legacy rows)", () => {
    const [stamped] = stampRefundExposure([sub()], {
      profilesById: new Map([["prof-1", OPEN_PROFILE]]),
      vpsProviderByBusinessId: new Map(),
      now: NOW
    });
    expect(stamped.refund_exposed).toBe(true);
  });

  it("does not expose non-hostinger placements (no self-serve refund there)", () => {
    const [stamped] = stampRefundExposure([sub()], {
      profilesById: new Map([["prof-1", OPEN_PROFILE]]),
      vpsProviderByBusinessId: new Map([["biz-1", "byos"]]),
      now: NOW
    });
    expect(stamped.refund_exposed).toBe(false);
  });

  it("does not expose a closed or used refund window", () => {
    const stamped = stampRefundExposure(
      [
        sub({ customer_profile_id: "prof-old" }),
        sub({ customer_profile_id: "prof-used" })
      ],
      {
        profilesById: new Map([
          // Paid > 30 days before NOW → window closed.
          ["prof-old", { first_paid_at: "2026-05-01T00:00:00Z", refund_used_at: null }],
          // Refund already consumed.
          [
            "prof-used",
            { first_paid_at: "2026-07-05T00:00:00Z", refund_used_at: "2026-07-06T00:00:00Z" }
          ]
        ]),
        vpsProviderByBusinessId: new Map([["biz-1", "hostinger"]]),
        now: NOW
      }
    );
    expect(stamped.map((s) => s.refund_exposed)).toEqual([false, false]);
  });

  it("does not expose subscriptions without a profile (null id or missing row)", () => {
    const stamped = stampRefundExposure(
      [sub({ customer_profile_id: null }), sub({ customer_profile_id: "prof-ghost" })],
      {
        profilesById: new Map(),
        vpsProviderByBusinessId: new Map([["biz-1", "hostinger"]]),
        now: NOW
      }
    );
    expect(stamped.map((s) => s.refund_exposed)).toEqual([false, false]);
  });

  it("defaults `now` to the current time", () => {
    // Window opened "just now" relative to real time so the assertion is stable.
    const [stamped] = stampRefundExposure([sub()], {
      profilesById: new Map([
        ["prof-1", { first_paid_at: new Date().toISOString(), refund_used_at: null }]
      ]),
      vpsProviderByBusinessId: new Map([["biz-1", "hostinger"]])
    });
    expect(stamped.refund_exposed).toBe(true);
  });
});

function makeProfilesClient(opts: {
  data?: Array<Record<string, unknown>> | null;
  error?: { message: string } | null;
}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: opts.data ?? null, error: opts.error ?? null })
  };
  return { client: { from: vi.fn(() => chain) }, chain };
}

describe("listCustomerProfilesByIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty map without querying when no ids are given", async () => {
    const { client } = makeProfilesClient({ data: [] });
    const result = await listCustomerProfilesByIds([], client as never);
    expect(result.size).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("maps returned rows by id", async () => {
    const { client, chain } = makeProfilesClient({
      data: [
        { id: "prof-1", ...OPEN_PROFILE },
        { id: "prof-2", first_paid_at: null, refund_used_at: null }
      ]
    });
    const result = await listCustomerProfilesByIds(["prof-1", "prof-2"], client as never);
    expect(client.from).toHaveBeenCalledWith("customer_profiles");
    expect(chain.in).toHaveBeenCalledWith("id", ["prof-1", "prof-2"]);
    expect(result.get("prof-1")?.first_paid_at).toBe("2026-07-05T00:00:00Z");
    expect(result.size).toBe(2);
  });

  it("tolerates a null data payload", async () => {
    const { client } = makeProfilesClient({ data: null });
    const result = await listCustomerProfilesByIds(["prof-1"], client as never);
    expect(result.size).toBe(0);
  });

  it("throws on a query error", async () => {
    const { client } = makeProfilesClient({ error: { message: "boom" } });
    await expect(listCustomerProfilesByIds(["prof-1"], client as never)).rejects.toThrow(
      "listCustomerProfilesByIds: boom"
    );
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeProfilesClient({ data: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const result = await listCustomerProfilesByIds(["prof-1"]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe("stampRefundExposureFromDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches only profiles that could count toward MRR and stamps exposure", async () => {
    const { client, chain } = makeProfilesClient({
      data: [{ id: "prof-1", ...OPEN_PROFILE }]
    });
    const stamped = await stampRefundExposureFromDb(
      [
        sub(),
        sub({ status: "pending", customer_profile_id: "prof-skip-status" }),
        sub({ stripe_subscription_id: null, customer_profile_id: "prof-skip-stripe" }),
        sub({ tier: "enterprise", customer_profile_id: "prof-skip-tier" }),
        sub({ customer_profile_id: null }),
        // Duplicate profile id must be deduped in the fetch.
        sub({ business_id: "biz-2" })
      ],
      [
        { id: "biz-1", vps_provider: "hostinger" },
        { id: "biz-2" } // missing provider → null → hostinger
      ],
      { now: NOW, client: client as never }
    );
    expect(chain.in).toHaveBeenCalledWith("id", ["prof-1"]);
    expect(stamped.map((s) => s.refund_exposed)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true
    ]);
  });

  it("uses the service client and current time by default", async () => {
    const { client } = makeProfilesClient({
      data: [{ id: "prof-1", first_paid_at: new Date().toISOString(), refund_used_at: null }]
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const stamped = await stampRefundExposureFromDb(
      [sub()],
      [{ id: "biz-1", vps_provider: "hostinger" }]
    );
    expect(stamped[0].refund_exposed).toBe(true);
  });
});
