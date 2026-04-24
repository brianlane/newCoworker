import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUserMock,
  supabaseFromMock,
  loadLifecycleContextMock,
  executeLifecyclePlanMock,
  createCheckoutSessionMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  loadLifecycleContextMock: vi.fn(),
  executeLifecyclePlanMock: vi.fn(),
  createCheckoutSessionMock: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: getAuthUserMock
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({
    from: supabaseFromMock
  })
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: loadLifecycleContextMock
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: executeLifecyclePlanMock
}));

vi.mock("@/lib/stripe/client", () => ({
  createCheckoutSession: createCheckoutSessionMock,
  resolvePriceId: vi.fn((tier: string, period: string) => `price_${tier}_${period}`)
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import { POST } from "@/app/api/billing/reactivate/route";

function makeContext(overrides = {}) {
  return {
    subscription: {
      id: "sub_1",
      business_id: "biz_1",
      status: "canceled",
      tier: "starter",
      billing_period: "monthly",
      grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      wiped_at: null,
      customer_profile_id: "prof_1",
      cancel_at_period_end: false,
      stripe_subscription_id: "sub_old"
    },
    profile: {
      id: "prof_1",
      lifetime_subscription_count: 1
    },
    ownerEmail: "owner@example.com",
    ownerAuthUserId: "user_1",
    virtualMachineId: 42,
    vpsHost: "1.2.3.4",
    ...overrides
  };
}

describe("/api/billing/reactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    getAuthUserMock.mockResolvedValue({
      userId: "user_1",
      email: "owner@example.com",
      isAdmin: false
    });
    supabaseFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ id: "biz_1" }], error: null })
    });
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: makeContext()
    });
    executeLifecyclePlanMock.mockResolvedValue({});
    createCheckoutSessionMock.mockResolvedValue({ url: "https://stripe.example/checkout" });
  });

  it("allows grace reactivation with only mode and defaults to the previous tier/period", async () => {
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "resubscribe" })
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.checkoutUrl).toBe("https://stripe.example/checkout");
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_starter_monthly",
        metadata: expect.objectContaining({
          businessId: "biz_1",
          tier: "starter",
          billingPeriod: "monthly",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof_1"
        })
      })
    );
  });
});
