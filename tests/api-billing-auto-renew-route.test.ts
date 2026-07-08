import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 2 (agency): the route resolves the ACTIVE business through the
// cookie-aware helper; pin it to a fixed id here — the supabase chain mock
// below still decides which rows come back, so existing fixtures keep
// driving each scenario.
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111")
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    getSubscription: vi.fn(),
    updateSubscription: vi.fn()
  };
});

vi.mock("@/lib/stripe/client", () => ({
  ensureCommitmentSchedule: vi.fn(),
  releaseCommitmentSchedule: vi.fn()
}));

import { POST } from "@/app/api/billing/auto-renew/route";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { ensureCommitmentSchedule, releaseCommitmentSchedule } from "@/lib/stripe/client";

const BID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";

function mockBusinessesQuery(rows: Array<{ id: string }>) {
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null })
  } as never);
}

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/billing/auto-renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const ACTIVE_TERM_SUB = {
  id: "sub-row-1",
  business_id: BID,
  status: "active",
  tier: "standard",
  billing_period: "biennial",
  stripe_subscription_id: "sub_stripe_1",
  contract_auto_renew: false,
  // Mid-commitment: term ends next year, Stripe period spans the term.
  renewal_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  stripe_current_period_start: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  stripe_current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
};

describe("api/billing/auto-renew route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: UID,
      email: "owner@example.com",
      isAdmin: false
    } as never);
    mockBusinessesQuery([{ id: BID }]);
    vi.mocked(getSubscription).mockResolvedValue(ACTIVE_TERM_SUB as never);
    vi.mocked(updateSubscription).mockResolvedValue(undefined as never);
    vi.mocked(releaseCommitmentSchedule).mockResolvedValue("sub_sched_1");
    vi.mocked(ensureCommitmentSchedule).mockResolvedValue("sub_sched_1");
  });

  it("turning auto-renew ON releases the schedule and flips the flag", async () => {
    const res = await POST(buildRequest({ autoRenew: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.autoRenew).toBe(true);
    expect(releaseCommitmentSchedule).toHaveBeenCalledWith("sub_stripe_1");
    expect(ensureCommitmentSchedule).not.toHaveBeenCalled();
    expect(updateSubscription).toHaveBeenCalledWith(
      "sub-row-1",
      { contract_auto_renew: true },
      expect.anything()
    );
  });

  it("turning auto-renew OFF re-creates the rollover schedule and flips the flag", async () => {
    const res = await POST(buildRequest({ autoRenew: false }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.autoRenew).toBe(false);
    expect(ensureCommitmentSchedule).toHaveBeenCalledWith({
      subscriptionId: "sub_stripe_1",
      tier: "standard",
      billingPeriod: "biennial"
    });
    expect(releaseCommitmentSchedule).not.toHaveBeenCalled();
    expect(updateSubscription).toHaveBeenCalledWith(
      "sub-row-1",
      { contract_auto_renew: false },
      expect.anything()
    );
  });

  it("does not flip the DB flag when the Stripe change fails", async () => {
    vi.mocked(releaseCommitmentSchedule).mockRejectedValue(new Error("stripe down"));

    const res = await POST(buildRequest({ autoRenew: true }));

    expect(res.status).toBe(500);
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("409s on a monthly subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      ...ACTIVE_TERM_SUB,
      billing_period: "monthly"
    } as never);

    const res = await POST(buildRequest({ autoRenew: true }));
    expect(res.status).toBe(409);
    expect(releaseCommitmentSchedule).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("409s when the commitment has already elapsed (rollover phase — start a new contract instead)", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      ...ACTIVE_TERM_SUB,
      // Term ended yesterday; the live Stripe period is now a single month.
      renewal_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      stripe_current_period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      stripe_current_period_end: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString()
    } as never);

    const res = await POST(buildRequest({ autoRenew: true }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toContain("start a new contract");
    expect(releaseCommitmentSchedule).not.toHaveBeenCalled();
    expect(ensureCommitmentSchedule).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("409s when there is no active subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      ...ACTIVE_TERM_SUB,
      status: "pending",
      stripe_subscription_id: null
    } as never);

    const res = await POST(buildRequest({ autoRenew: true }));
    expect(res.status).toBe(409);
  });

  it("403s when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(buildRequest({ autoRenew: true }));
    expect(res.status).toBe(403);
  });

  it("404s when the user owns no business", async () => {
    mockBusinessesQuery([]);
    const res = await POST(buildRequest({ autoRenew: true }));
    expect(res.status).toBe(404);
  });
});
