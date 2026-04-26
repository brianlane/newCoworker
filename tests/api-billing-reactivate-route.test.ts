import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUserMock,
  supabaseFromMock,
  loadLifecycleContextMock,
  executeLifecyclePlanMock,
  createCheckoutSessionMock,
  planLifecycleActionMock,
  isCanceledInGraceMock,
  upsertCustomerProfileMock,
  getCustomerProfileByIdMock,
  setBusinessCustomerProfileMock,
  loggerErrorMock,
  loggerWarnMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  loadLifecycleContextMock: vi.fn(),
  executeLifecyclePlanMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
  planLifecycleActionMock: vi.fn(),
  isCanceledInGraceMock: vi.fn(),
  upsertCustomerProfileMock: vi.fn(),
  getCustomerProfileByIdMock: vi.fn(),
  setBusinessCustomerProfileMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn()
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

vi.mock("@/lib/billing/lifecycle", () => ({
  planLifecycleAction: planLifecycleActionMock,
  isCanceledInGrace: isCanceledInGraceMock
}));

vi.mock("@/lib/stripe/client", () => ({
  createCheckoutSession: createCheckoutSessionMock,
  resolvePriceId: vi.fn((tier: string, period: string) => `price_${tier}_${period}`)
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  LIFETIME_SUBSCRIPTION_CAP: 3,
  upsertCustomerProfile: upsertCustomerProfileMock,
  getCustomerProfileById: getCustomerProfileByIdMock
}));

vi.mock("@/lib/db/businesses", () => ({
  setBusinessCustomerProfile: setBusinessCustomerProfileMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

import { POST } from "@/app/api/billing/reactivate/route";

function makeContext(overrides: Record<string, unknown> = {}) {
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

function makeSupabaseBusinessChain(businessId: string | null) {
  const limit = vi.fn().mockResolvedValue({
    data: businessId ? [{ id: businessId }] : [],
    error: null
  });
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit
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
    supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain("biz_1"));
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: makeContext()
    });
    planLifecycleActionMock.mockReturnValue({
      ok: true,
      plan: { stripeOps: [], dbUpdates: [], sshOps: [], hostingerOps: [], emailsToSend: [] }
    });
    isCanceledInGraceMock.mockReturnValue(true);
    executeLifecyclePlanMock.mockResolvedValue({});
    createCheckoutSessionMock.mockResolvedValue({ url: "https://stripe.example/checkout" });
    upsertCustomerProfileMock.mockResolvedValue("prof_upserted");
    getCustomerProfileByIdMock.mockResolvedValue({
      id: "prof_upserted",
      lifetime_subscription_count: 0
    });
    setBusinessCustomerProfileMock.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated callers with 403", async () => {
    getAuthUserMock.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "resubscribe" })
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the user has no business", async () => {
    supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain(null));
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "resubscribe" })
      })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when lifecycle context cannot be loaded", async () => {
    loadLifecycleContextMock.mockResolvedValue({ ok: false, reason: "subscription_not_found" });
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "resubscribe" })
      })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid body (zod)", async () => {
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "bogus" })
      })
    );
    expect(res.status).toBe(400);
  });

  describe("undoPeriodEnd", () => {
    it("executes the lifecycle plan and returns success", async () => {
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "undoPeriodEnd" })
        })
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toEqual({ mode: "undoPeriodEnd" });
      expect(executeLifecyclePlanMock).toHaveBeenCalledOnce();
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it("returns 409 when the planner rejects the undo", async () => {
      planLifecycleActionMock.mockReturnValue({ ok: false, reason: "nothing_to_undo" });
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "undoPeriodEnd" })
        })
      );
      expect(res.status).toBe(409);
    });

    it("returns 500 when the executor throws", async () => {
      executeLifecyclePlanMock.mockRejectedValue(new Error("stripe boom"));
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "undoPeriodEnd" })
        })
      );
      expect(res.status).toBe(500);
      expect(loggerErrorMock).toHaveBeenCalled();
    });
  });

  describe("resubscribe", () => {
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

    it("allows resubscribe with explicit tier/period override", async () => {
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({
            mode: "resubscribe",
            tier: "standard",
            billingPeriod: "annual"
          })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.checkoutUrl).toBe("https://stripe.example/checkout");
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: "price_standard_annual" })
      );
    });

    it("returns 409 subscription_not_in_grace when outside grace", async () => {
      isCanceledInGraceMock.mockReturnValue(false);
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("subscription_not_in_grace");
    });

    it("returns 409 lifetime_subscription_cap_reached when profile is at cap", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          profile: { id: "prof_1", lifetime_subscription_count: 3 }
        })
      });
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("lifetime_subscription_cap_reached");
    });

    it("upserts profile when none is attached and blocks at cap via refreshed row", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          subscription: {
            id: "sub_1",
            business_id: "biz_1",
            status: "canceled",
            tier: "starter",
            billing_period: "monthly",
            grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            wiped_at: null,
            customer_profile_id: null,
            cancel_at_period_end: false,
            stripe_subscription_id: "sub_old"
          },
          profile: null
        })
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 3
      });

      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("lifetime_subscription_cap_reached");
      expect(upsertCustomerProfileMock).toHaveBeenCalledWith({
        email: "owner@example.com",
        signupIp: null
      });
      expect(setBusinessCustomerProfileMock).toHaveBeenCalledWith("biz_1", "prof_new");
    });

    it("fails closed with 500 when upsertCustomerProfile throws", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({ profile: null, subscription: { ...makeContext().subscription, customer_profile_id: null } })
      });
      upsertCustomerProfileMock.mockRejectedValue(new Error("db boom"));
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      expect(res.status).toBe(500);
      expect(loggerErrorMock).toHaveBeenCalled();
    });

    it("fails closed with 500 when getCustomerProfileById returns null post-upsert", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({ profile: null, subscription: { ...makeContext().subscription, customer_profile_id: null } })
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue(null);

      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      expect(res.status).toBe(500);
      expect(loggerWarnMock).toHaveBeenCalled();
    });

    it("continues when setBusinessCustomerProfile fails during upsert path", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({ profile: null, subscription: { ...makeContext().subscription, customer_profile_id: null } })
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      setBusinessCustomerProfileMock.mockRejectedValue(new Error("attach failed"));
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 0
      });

      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      expect(res.status).toBe(200);
      expect(loggerWarnMock).toHaveBeenCalled();
    });

    it("returns 409 for unsupported tier on resubscribe", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          subscription: {
            ...makeContext().subscription,
            tier: "legacy"
          }
        })
      });
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("unsupported_reactivation_tier");
    });

    it("returns 409 for unsupported billing period on resubscribe", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          subscription: {
            ...makeContext().subscription,
            billing_period: "weekly"
          }
        })
      });
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("unsupported_reactivation_period");
    });

    it("omits customerProfileId from checkout metadata when none can be resolved", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          profile: { id: "prof_1", lifetime_subscription_count: 1 },
          subscription: {
            ...makeContext().subscription,
            customer_profile_id: null
          }
        })
      });
      const res = await POST(
        new Request("http://localhost/api/billing/reactivate", {
          method: "POST",
          body: JSON.stringify({ mode: "resubscribe" })
        })
      );
      expect(res.status).toBe(200);
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customerProfileId: "prof_1"
          })
        })
      );
    });

    it("defaults NEXT_PUBLIC_APP_URL when not set", async () => {
      const prev = process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;
      try {
        const res = await POST(
          new Request("http://localhost/api/billing/reactivate", {
            method: "POST",
            body: JSON.stringify({ mode: "resubscribe" })
          })
        );
        expect(res.status).toBe(200);
        expect(createCheckoutSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            successUrl: "http://localhost:3000/dashboard/billing?reactivated=1"
          })
        );
      } finally {
        process.env.NEXT_PUBLIC_APP_URL = prev;
      }
    });
  });

  it("handles unexpected errors via handleRouteError (500)", async () => {
    loadLifecycleContextMock.mockRejectedValue(new Error("boom"));
    const res = await POST(
      new Request("http://localhost/api/billing/reactivate", {
        method: "POST",
        body: JSON.stringify({ mode: "resubscribe" })
      })
    );
    expect(res.status).toBe(500);
  });
});
