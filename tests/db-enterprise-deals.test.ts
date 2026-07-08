import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createEnterpriseDeal,
  listEnterpriseDeals,
  getEnterpriseDeal,
  getEnterpriseDealByPayToken,
  revokeEnterpriseDeal,
  markEnterpriseDealActive,
  markEnterpriseDealCanceledByStripeSubscriptionId,
  enterpriseDealPayUrl
} from "@/lib/db/enterprise-deals";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const DEAL = {
  id: "0d0d0d0d-0000-4000-8000-000000000001",
  business_id: "0d0d0d0d-0000-4000-8000-0000000000bb",
  setup_cents: 82_500,
  monthly_cents: 49_500,
  status: "open",
  created_by: "admin@test.com",
  created_at: "2026-07-08T00:00:00Z",
  activated_at: null,
  stripe_session_id: null,
  stripe_subscription_id: null,
  pay_token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
};

describe("db/enterprise-deals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createEnterpriseDeal inserts and returns the row", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: DEAL, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const row = await createEnterpriseDeal({
      businessId: DEAL.business_id,
      setupCents: DEAL.setup_cents,
      monthlyCents: DEAL.monthly_cents,
      createdBy: DEAL.created_by
    });
    expect(row).toEqual(DEAL);
    expect(db.insert).toHaveBeenCalledWith({
      business_id: DEAL.business_id,
      setup_cents: DEAL.setup_cents,
      monthly_cents: DEAL.monthly_cents,
      created_by: DEAL.created_by
    });
  });

  it("createEnterpriseDeal throws on error (e.g. one-live-deal unique index)", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "enterprise_deals_one_live_per_business_idx violation" }
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      createEnterpriseDeal({
        businessId: DEAL.business_id,
        setupCents: 0,
        monthlyCents: 100,
        createdBy: "a@b.c"
      })
    ).rejects.toThrow(/enterprise_deals_one_live_per_business_idx/);
  });

  it("listEnterpriseDeals returns rows ([] for null data)", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [DEAL], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listEnterpriseDeals(DEAL.business_id)).toEqual([DEAL]);

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    expect(await listEnterpriseDeals(DEAL.business_id)).toEqual([]);
  });

  it("getEnterpriseDeal / getEnterpriseDealByPayToken return null when absent", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getEnterpriseDeal(DEAL.id)).toBeNull();
    expect(await getEnterpriseDealByPayToken(DEAL.pay_token)).toBeNull();
  });

  it("revokeEnterpriseDeal only flips OPEN deals (guarded update)", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: DEAL.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await revokeEnterpriseDeal(DEAL.id)).toBe(true);
    expect(db.update).toHaveBeenCalledWith({ status: "revoked" });
    expect(db.eq).toHaveBeenCalledWith("status", "open");

    const noMatch = mockDb({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(noMatch as never);
    expect(await revokeEnterpriseDeal(DEAL.id)).toBe(false);
  });

  it("markEnterpriseDealActive claims atomically and reports duplicate sessions", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: DEAL.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await markEnterpriseDealActive(DEAL.id, {
      activatedAt: new Date("2026-07-08T12:00:00Z"),
      stripeSessionId: "cs_1",
      stripeSubscriptionId: "sub_1"
    });
    expect(result).toBe("active");
    expect(db.update).toHaveBeenCalledWith({
      status: "active",
      activated_at: "2026-07-08T12:00:00.000Z",
      stripe_session_id: "cs_1",
      stripe_subscription_id: "sub_1"
    });
    // The claim predicate: not-yet-active OR already active from this session.
    expect(db.or).toHaveBeenCalledWith("status.neq.active,stripe_session_id.eq.cs_1");

    const noMatch = mockDb({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(noMatch as never);
    expect(
      await markEnterpriseDealActive(DEAL.id, {
        activatedAt: new Date(),
        stripeSessionId: "cs_2",
        stripeSubscriptionId: "sub_2"
      })
    ).toBe("duplicate_session");
  });

  it("markEnterpriseDealCanceledByStripeSubscriptionId only flips ACTIVE deals", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: DEAL.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await markEnterpriseDealCanceledByStripeSubscriptionId("sub_1")).toBe(true);
    expect(db.update).toHaveBeenCalledWith({ status: "canceled" });
    expect(db.eq).toHaveBeenCalledWith("stripe_subscription_id", "sub_1");
    expect(db.eq).toHaveBeenCalledWith("status", "active");

    const noMatch = mockDb({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(noMatch as never);
    expect(await markEnterpriseDealCanceledByStripeSubscriptionId("sub_other")).toBe(false);
  });

  it("enterpriseDealPayUrl builds the public link from NEXT_PUBLIC_APP_URL", () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    try {
      expect(enterpriseDealPayUrl(DEAL)).toBe(
        `https://app.example.com/enterprise-offer/${DEAL.pay_token}`
      );
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });
});
