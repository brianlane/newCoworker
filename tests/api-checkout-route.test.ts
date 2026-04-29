import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  verifySignupIdentity: vi.fn(),
  authUserExistsByEmail: vi.fn()
}));

vi.mock("@/lib/stripe/client", () => ({
  createCheckoutSession: vi.fn(),
  resolveIntroDiscountCouponId: vi.fn(),
  resolvePriceId: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  createSubscription: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  setBusinessCustomerProfile: vi.fn()
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  LIFETIME_SUBSCRIPTION_CAP: 3,
  upsertCustomerProfile: vi.fn(),
  getCustomerProfileById: vi.fn()
}));

vi.mock("@/lib/onboarding/token", () => ({
  verifyOnboardingToken: vi.fn(),
  createPendingOwnerEmail: vi.fn((businessId: string) => `pending+${businessId}@onboarding.local`)
}));

import { POST } from "@/app/api/checkout/route";
import { authUserExistsByEmail, getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createCheckoutSession, resolveIntroDiscountCouponId, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription } from "@/lib/db/subscriptions";
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { upsertCustomerProfile, getCustomerProfileById } from "@/lib/db/customer-profiles";
import { verifyOnboardingToken } from "@/lib/onboarding/token";

describe("api/checkout route", () => {
  const OLD_ENV = process.env;
  const businessId = "11111111-1111-4111-8111-111111111111";
  const signupUserId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, NEXT_PUBLIC_APP_URL: "http://localhost:3000" };
    vi.mocked(resolvePriceId).mockReturnValue("price_test");
    vi.mocked(resolveIntroDiscountCouponId).mockReturnValue(undefined);
    vi.mocked(createSubscription).mockResolvedValue({} as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`
    } as never);
    vi.mocked(verifyOnboardingToken).mockReturnValue(false);
    // Default the strict email-uniqueness gate to "available" so the
    // existing onboarding-token tests below keep passing without
    // having to opt into the gate explicitly. Tests that exercise the
    // gate override this in-place.
    vi.mocked(authUserExistsByEmail).mockResolvedValue(false);
    vi.mocked(createCheckoutSession).mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.test/session"
    });
    vi.mocked(upsertCustomerProfile).mockResolvedValue("profile-1" as never);
    vi.mocked(getCustomerProfileById).mockResolvedValue({
      id: "profile-1",
      normalized_email: "owner@example.com",
      stripe_customer_id: null,
      last_signup_ip: null,
      lifetime_subscription_count: 0,
      refund_used_at: null,
      first_paid_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as never);
    vi.mocked(setBusinessCustomerProfile).mockResolvedValue(undefined as never);
  });

  it("blocks checkout once the lifetime subscription cap is reached", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getCustomerProfileById).mockResolvedValue({
      id: "profile-1",
      normalized_email: "owner@example.com",
      stripe_customer_id: null,
      last_signup_ip: null,
      lifetime_subscription_count: 3,
      refund_used_at: null,
      first_paid_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("allows unconfirmed signup users to create checkout when identity is verified", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "biennial",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.checkoutUrl).toBe("https://checkout.stripe.test/session");
    expect(verifySignupIdentity).toHaveBeenCalledWith(signupUserId, "owner@example.com");
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelUrl: "http://localhost:3000/onboard/questionnaire?tier=standard&period=biennial",
        customerEmail: "owner@example.com",
        metadata: expect.objectContaining({
          userId: signupUserId,
          businessId,
          tier: "standard",
          billingPeriod: "biennial"
        })
      })
    );
  });

  it("rejects unauthenticated checkout when signup identity fields are missing", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "annual"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Authentication required");
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated checkout when signup identity cannot be verified", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(false);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Not authorized for checkout");
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("allows onboarding-token checkout when the business is still pending", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyOnboardingToken).mockReturnValue(true);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "owner@example.com",
        onboardingToken: "token"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(getBusiness).toHaveBeenCalledWith(businessId);
    expect(createSubscription).toHaveBeenCalled();
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: "owner@example.com",
        metadata: expect.objectContaining({
          userId: businessId
        })
      })
    );
  });

  it("blocks checkout when the authenticated user has no email on session", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: signupUserId,
      email: null,
      isAdmin: false
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "annual"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/verified email is required/i);
    expect(upsertCustomerProfile).not.toHaveBeenCalled();
    expect(getCustomerProfileById).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when profile readback returns null after a successful upsert", async () => {
    // Previously this branch short-circuited on `profile && count >=
    // CAP`, so a null readback silently bypassed the lifetime cap check
    // (see the "Stale profile check bypasses lifetime cap on checkout"
    // screenshot). We now fail closed so the client retries.
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getCustomerProfileById).mockResolvedValue(null as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.message).toMatch(/verify subscription eligibility/i);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when the profile readback throws", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getCustomerProfileById).mockRejectedValue(new Error("db read timeout"));

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.message).toMatch(/verify subscription eligibility/i);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects onboarding-token checkout when the business is no longer pending", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyOnboardingToken).mockReturnValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: "owner@example.com"
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "owner@example.com",
        onboardingToken: "token"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Onboarding token is no longer valid");
    expect(createSubscription).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("blocks anonymous onboarding-token checkout when the email already has an auth user", async () => {
    // The pre-payment account-uniqueness gate is the primary mechanism
    // that keeps "account creation" and "password reset" as separate
    // flows. Without it, an attacker could pay a Stripe Checkout for a
    // victim's email and reach /api/onboard/set-password with a
    // session that names that email — even though set-password itself
    // is now create-only, sending a paid customer to a guaranteed 409
    // is poor UX and the right place to refuse is here.
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyOnboardingToken).mockReturnValue(true);
    vi.mocked(authUserExistsByEmail).mockResolvedValue(true);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "victim@example.com",
        onboardingToken: "token"
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(authUserExistsByEmail).toHaveBeenCalledWith("victim@example.com");
    expect(upsertCustomerProfile).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when the strict email-uniqueness lookup throws (transient DB error)", async () => {
    // `authUserExistsByEmail` throws on lookup failure (vs. the soft
    // `findAuthUserIdByEmail` helper which collapses errors to null).
    // The /api/checkout gate must surface that as a 500 so the client
    // retries — silently allowing the checkout through would re-open
    // the bypass this entire gate exists to close.
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifyOnboardingToken).mockReturnValue(true);
    vi.mocked(authUserExistsByEmail).mockRejectedValue(new Error("rpc replica timeout"));

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "annual",
        ownerEmail: "owner@example.com",
        onboardingToken: "token"
      })
    });

    const response = await POST(request);

    expect(response.status).toBe(500);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("does NOT call the strict email-uniqueness lookup for authenticated users (existing-user happy path)", async () => {
    // An authenticated user spinning up a SECOND business goes through
    // the user-branch on /api/checkout, not the onboardingToken
    // branch. They obviously already have an auth user; running the
    // gate against their own email would falsely 409 them.
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: signupUserId,
      email: "owner@example.com",
      isAdmin: false
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "biennial"
      })
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(authUserExistsByEmail).not.toHaveBeenCalled();
    expect(createCheckoutSession).toHaveBeenCalled();
  });
});
