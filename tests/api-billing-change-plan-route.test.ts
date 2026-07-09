import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUserMock,
  supabaseFromMock,
  loadLifecycleContextMock,
  createCheckoutSessionMock,
  stripeSubscriptionRetrieveMock,
  upsertCustomerProfileMock,
  getCustomerProfileByIdMock,
  setBusinessCustomerProfileMock,
  updateSubscriptionMock,
  loggerErrorMock,
  loggerWarnMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  loadLifecycleContextMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
  stripeSubscriptionRetrieveMock: vi.fn(),
  upsertCustomerProfileMock: vi.fn(),
  getCustomerProfileByIdMock: vi.fn(),
  setBusinessCustomerProfileMock: vi.fn(),
  updateSubscriptionMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn()
}));

// Phase 2 (agency): the route resolves the ACTIVE business through the
// cookie-aware helper; pin it to a fixed id here — the supabase chain mock
// below still decides which rows come back, so existing fixtures keep
// driving each scenario.
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111")
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

vi.mock("@/lib/stripe/client", () => ({
  createCheckoutSession: createCheckoutSessionMock,
  getStripe: () => ({ subscriptions: { retrieve: stripeSubscriptionRetrieveMock } }),
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

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    updateSubscription: updateSubscriptionMock
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

import { POST } from "@/app/api/billing/change-plan/route";

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    subscription: {
      id: "sub_1",
      business_id: "biz_1",
      status: "active",
      tier: "starter",
      billing_period: "monthly",
      customer_profile_id: "prof_1",
      cancel_at_period_end: false
    },
    profile: {
      id: "prof_1",
      lifetime_subscription_count: 1
    },
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
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/billing/change-plan", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

describe("/api/billing/change-plan", () => {
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
    createCheckoutSessionMock.mockResolvedValue({ url: "https://stripe.example/checkout" });
    // Default old Stripe sub carries no Canada-fee flag (US / grandfathered).
    stripeSubscriptionRetrieveMock.mockResolvedValue({ metadata: {} });
    upsertCustomerProfileMock.mockResolvedValue("prof_upserted");
    getCustomerProfileByIdMock.mockResolvedValue({
      id: "prof_upserted",
      lifetime_subscription_count: 0
    });
    setBusinessCustomerProfileMock.mockResolvedValue(undefined);
    updateSubscriptionMock.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated callers with 403", async () => {
    getAuthUserMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    expect(res.status).toBe(403);
  });

  it("rejects invalid body with 400", async () => {
    const res = await POST(makeRequest({ tier: "gold", billingPeriod: "weekly" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the user has no business", async () => {
    supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain(null));
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when lifecycle context cannot be loaded", async () => {
    loadLifecycleContextMock.mockResolvedValue({ ok: false, reason: "subscription_not_found" });
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the subscription is not active", async () => {
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: makeContext({
        subscription: { ...makeContext().subscription, status: "canceled" }
      })
    });
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("subscription_not_active");
  });

  it("returns 409 when the profile has already hit the lifetime cap", async () => {
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: makeContext({
        profile: { id: "prof_1", lifetime_subscription_count: 3 }
      })
    });
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("lifetime_subscription_cap_reached");
  });

  it("returns 409 plan_unchanged when tier and period match current", async () => {
    const res = await POST(makeRequest({ tier: "starter", billingPeriod: "monthly" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("plan_unchanged");
  });

  describe("same-plan re-contract after commitment elapses", () => {
    function termContext(overrides: Record<string, unknown> = {}) {
      return makeContext({
        subscription: {
          id: "sub_term",
          business_id: "biz_1",
          status: "active",
          tier: "standard",
          billing_period: "biennial",
          customer_profile_id: "prof_1",
          cancel_at_period_end: false,
          stripe_subscription_id: "stripe_sub_1",
          // Term ended yesterday → month-to-month rollover phase (the live
          // Stripe period is now a single month, not the prepaid term).
          renewal_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          stripe_current_period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          stripe_current_period_end: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
          ...overrides
        }
      });
    }

    it("allows same tier+period once the commitment elapsed and stamps recontract metadata", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: termContext()
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "biennial" }));
      expect(res.status).toBe(200);
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            lifecycleAction: "changePlan",
            recontract: "1"
          })
        })
      );
    });

    it("exempts a re-contract from the lifetime subscription cap", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: {
          ...termContext(),
          profile: { id: "prof_1", lifetime_subscription_count: 3 }
        }
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "biennial" }));
      expect(res.status).toBe(200);
    });

    it("still rejects same plan while the commitment is running", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: termContext({ renewal_at: "2099-01-01T00:00:00.000Z" })
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "biennial" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("plan_unchanged");
    });

    it("does not treat an elapsed sub without a Stripe subscription as re-contract eligible", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: termContext({ stripe_subscription_id: null })
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "biennial" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("plan_unchanged");
    });

    it("does not treat a renewed full term (stale renewal_at, multi-month Stripe period) as re-contract eligible", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: termContext({
          stripe_current_period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          stripe_current_period_end: new Date(
            Date.now() + 729 * 24 * 60 * 60 * 1000
          ).toISOString()
        })
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "biennial" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("plan_unchanged");
    });

    it("does not stamp recontract metadata on an ordinary plan change", async () => {
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      const metadata = createCheckoutSessionMock.mock.calls[0][0].metadata;
      expect(metadata.recontract).toBeUndefined();
    });
  });

  it("creates a checkout session for a valid plan change", async () => {
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.checkoutUrl).toBe("https://stripe.example/checkout");
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_standard_annual",
        metadata: expect.objectContaining({
          lifecycleAction: "changePlan",
          previousSubscriptionId: "sub_1",
          customerProfileId: "prof_1"
        })
      })
    );
    // Old sub without the Canada flag (US or grandfathered pre-fee Canadian):
    // no surcharge on the replacement sub.
    const call = createCheckoutSessionMock.mock.calls.at(-1)?.[0];
    expect("canadaFee" in call).toBe(false);
    expect("canadianMessagingFee" in call.metadata).toBe(false);
  });

  describe("Canadian messaging surcharge carry-forward", () => {
    function ctxWithStripeSub() {
      return makeContext({
        subscription: {
          id: "sub_1",
          business_id: "biz_1",
          status: "active",
          tier: "starter",
          billing_period: "monthly",
          customer_profile_id: "prof_1",
          cancel_at_period_end: false,
          stripe_subscription_id: "stripe_sub_ca"
        }
      });
    }

    it("carries the fee onto the new plan when the old Stripe sub is flagged", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithStripeSub()
      });
      stripeSubscriptionRetrieveMock.mockResolvedValue({
        metadata: { canadianMessagingFee: "1" }
      });

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(stripeSubscriptionRetrieveMock).toHaveBeenCalledWith("stripe_sub_ca");
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          canadaFee: { monthlyCents: 499, billingPeriod: "annual" },
          metadata: expect.objectContaining({ canadianMessagingFee: "1" })
        })
      );
    });

    it("fails toward NOT charging when the old sub metadata can't be read", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithStripeSub()
      });
      stripeSubscriptionRetrieveMock.mockRejectedValue(new Error("stripe down"));

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      const call = createCheckoutSessionMock.mock.calls.at(-1)?.[0];
      expect("canadaFee" in call).toBe(false);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("Canada fee"),
        expect.anything()
      );
    });
  });

  describe("null-profile upsert path", () => {
    function ctxWithNoProfile() {
      return makeContext({
        subscription: {
          id: "sub_1",
          business_id: "biz_1",
          status: "active",
          tier: "starter",
          billing_period: "monthly",
          customer_profile_id: null,
          cancel_at_period_end: false
        },
        profile: null
      });
    }

    it("upserts a customer profile and proceeds when the refreshed profile is under cap", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithNoProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 0
      });

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(upsertCustomerProfileMock).toHaveBeenCalledWith({
        email: "owner@example.com",
        signupIp: null
      });
      expect(setBusinessCustomerProfileMock).toHaveBeenCalledWith("biz_1", "prof_new");
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customerProfileId: "prof_new"
          })
        })
      );
    });

    it("blocks with 409 when the upserted profile is at the lifetime cap", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithNoProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 3
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("lifetime_subscription_cap_reached");
    });

    it("fails closed with 500 when upsertCustomerProfile throws", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithNoProfile()
      });
      upsertCustomerProfileMock.mockRejectedValue(new Error("boom"));
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(500);
      expect(loggerErrorMock).toHaveBeenCalled();
    });

    it("fails closed with 500 when profile readback returns null", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithNoProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue(null);
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(500);
      expect(loggerWarnMock).toHaveBeenCalled();
    });

    it("continues when setBusinessCustomerProfile throws", async () => {
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithNoProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      setBusinessCustomerProfileMock.mockRejectedValue(new Error("attach failed"));
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 1
      });
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(loggerWarnMock).toHaveBeenCalled();
    });
  });

  describe("stale-linked-profile divergence (lifetime-cap split-accounting guard)", () => {
    // Regression: the subscription row may carry a `customer_profile_id`
    // that points at a hard-deleted (GDPR purge / manual cleanup) or
    // otherwise-unreadable profile row. In that case `loadLifecycleContext`
    // returns `profile=null` even though `subscription.customer_profile_id`
    // is set, so this route's null-profile branch fires, upserts by
    // owner email, and may receive a NEW profile id (count=0 fresh).
    // Without the repoint, the cap-check passes on the new id while the
    // old subscription row keeps pointing at the stale id — splitting
    // lifetime accounting across two rows and effectively bypassing the
    // lifetime cap because the orchestrator's `previousSubscriptionId`
    // lookup still resolves the stale id. The route must update
    // `subscription.customer_profile_id` to the resolved id so all
    // downstream lookups see the same profile we cap-checked.
    function ctxWithStaleLinkedProfile() {
      return makeContext({
        subscription: {
          id: "sub_stale",
          business_id: "biz_stale",
          status: "active",
          tier: "starter",
          billing_period: "monthly",
          customer_profile_id: "prof_stale_deleted",
          cancel_at_period_end: false
        },
        profile: null
      });
    }

    it("repoints the subscription row to the resolved profile id when the linked profile is missing", async () => {
      supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain("biz_stale"));
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithStaleLinkedProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_resolved");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_resolved",
        lifetime_subscription_count: 0
      });

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(updateSubscriptionMock).toHaveBeenCalledWith("sub_stale", {
        customer_profile_id: "prof_resolved"
      });
      expect(setBusinessCustomerProfileMock).toHaveBeenCalledWith("biz_stale", "prof_resolved");
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            previousSubscriptionId: "sub_stale",
            customerProfileId: "prof_resolved"
          })
        })
      );
    });

    it("does NOT repoint when the upsert returns the same id (no divergence)", async () => {
      supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain("biz_stale"));
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithStaleLinkedProfile()
      });
      // RPC primary-keys on normalized_email — when a profile already
      // exists for the owner email, upsert returns its existing id even
      // if the linked-by-id readback failed. No divergence → no need to
      // touch the subscription row.
      upsertCustomerProfileMock.mockResolvedValue("prof_stale_deleted");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_stale_deleted",
        lifetime_subscription_count: 0
      });

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(updateSubscriptionMock).not.toHaveBeenCalled();
    });

    it("survives an updateSubscription failure and still completes the change-plan", async () => {
      supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain("biz_stale"));
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: ctxWithStaleLinkedProfile()
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_resolved");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_resolved",
        lifetime_subscription_count: 0
      });
      updateSubscriptionMock.mockRejectedValue(new Error("constraint violation"));

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      // Best-effort write: the new checkout's metadata still threads the
      // resolved profile id, and the orchestrator's own re-upsert keeps
      // the new sub's lifetime accounting consistent. We log + continue
      // rather than failing the user's change-plan request.
      expect(res.status).toBe(200);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        "change-plan: failed to repoint subscription to resolved profile id (continuing)",
        expect.objectContaining({
          subscriptionRowId: "sub_stale",
          staleProfileId: "prof_stale_deleted",
          resolvedProfileId: "prof_resolved"
        })
      );
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customerProfileId: "prof_resolved"
          })
        })
      );
    });

    it("does NOT call updateSubscription when subscription.customer_profile_id is null (pre-lifecycle row)", async () => {
      // Pre-lifecycle businesses can have no linked profile at all.
      // There's no stale id to repoint from, so `updateSubscription`
      // should stay quiet — `setBusinessCustomerProfile` and the
      // checkout metadata are sufficient to thread the new id through.
      supabaseFromMock.mockReturnValue(makeSupabaseBusinessChain("biz_pre"));
      loadLifecycleContextMock.mockResolvedValue({
        ok: true,
        vpsHost: "1.2.3.4",
        context: makeContext({
          subscription: {
            id: "sub_pre",
            business_id: "biz_pre",
            status: "active",
            tier: "starter",
            billing_period: "monthly",
            customer_profile_id: null,
            cancel_at_period_end: false
          },
          profile: null
        })
      });
      upsertCustomerProfileMock.mockResolvedValue("prof_new");
      getCustomerProfileByIdMock.mockResolvedValue({
        id: "prof_new",
        lifetime_subscription_count: 0
      });

      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(updateSubscriptionMock).not.toHaveBeenCalled();
    });
  });

  it("defaults NEXT_PUBLIC_APP_URL when unset", async () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
      expect(res.status).toBe(200);
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          successUrl: "http://localhost:3000/dashboard/billing?planChanged=1"
        })
      );
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it("handles unexpected errors via handleRouteError", async () => {
    loadLifecycleContextMock.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest({ tier: "standard", billingPeriod: "annual" }));
    expect(res.status).toBe(500);
  });
});
