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
  createSubscription: vi.fn(),
  findCheckoutBlockingSubscription: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  listBusinessIdsByOwnerEmail: vi.fn(),
  setBusinessCustomerProfile: vi.fn(),
  updateBusinessPhone: vi.fn()
}));

vi.mock("@/lib/db/onboarding-drafts", () => ({
  getOnboardingDraft: vi.fn()
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
import { createSubscription, findCheckoutBlockingSubscription } from "@/lib/db/subscriptions";
import {
  getBusiness,
  listBusinessIdsByOwnerEmail,
  setBusinessCustomerProfile,
  updateBusinessPhone
} from "@/lib/db/businesses";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
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
    vi.mocked(findCheckoutBlockingSubscription).mockResolvedValue(null);
    vi.mocked(listBusinessIdsByOwnerEmail).mockResolvedValue([]);
    // Default the strict email-uniqueness gate to "available" so the
    // existing onboarding-token tests below keep passing without
    // having to opt into the gate explicitly. Tests that exercise the
    // gate override this in-place.
    vi.mocked(authUserExistsByEmail).mockResolvedValue(false);
    vi.mocked(getOnboardingDraft).mockResolvedValue(null as never);
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
        // Every NEW signup pays the one-time 10DLC carrier registration fee.
        oneTimeCarrierFeeCents: 1950,
        metadata: expect.objectContaining({
          userId: signupUserId,
          businessId,
          tier: "standard",
          billingPeriod: "biennial"
        })
      })
    );
    // A US business (default mock has no phone/timezone) never gets the
    // Canadian messaging surcharge.
    const usCall = vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0];
    expect(usCall && "canadaFee" in usCall).toBe(false);
    expect(usCall?.metadata && "canadianMessagingFee" in usCall.metadata).toBe(false);
  });

  it("adds the labeled Canadian messaging surcharge for a Canadian signup", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "4164560696", // Toronto
      timezone: "America/Toronto"
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "biennial",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "biennial" },
        metadata: expect.objectContaining({ canadianMessagingFee: "1" })
      })
    );
  });

  it("uses the caller's browser timezone only when the stored row has none (summary/charge lockstep)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    // Non-NANP phone (no area-code signal) and a legacy row with no stored
    // timezone: the body's browser timezone decides — same signal the Step 3
    // order summary previewed with.
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "+447911123456",
      timezone: null
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        timezone: "America/Toronto"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "monthly" }
      })
    );
  });

  it("prefers the freshest draft phone over a stale business-row phone on checkout retry", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    // Row created with a US phone; the owner edited it to a Toronto number
    // before retrying checkout — the draft (synced just before this call)
    // carries the value the order summary previewed the fee with.
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "6025551234",
      timezone: "America/Phoenix"
    } as never);
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: businessId,
      draft_token: "33333333-3333-4333-8333-333333333333",
      payload: { phone: "4164560696" }
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(getOnboardingDraft).toHaveBeenCalledWith(
      businessId,
      "33333333-3333-4333-8333-333333333333"
    );
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "monthly" }
      })
    );
    // The fresher phone is written back to the row — COERCED to E.164, the
    // only shape /api/business/create persists now — so PROVISIONING (which
    // classifies from the row) buys the number in the same country the fee
    // was billed for.
    expect(updateBusinessPhone).toHaveBeenCalledWith(businessId, "+14164560696");
  });

  it("classifies from the stored row when the phone write-back fails (billing matches provisioning)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "6025551234", // US row that provisioning will read
      timezone: "America/Phoenix"
    } as never);
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: businessId,
      draft_token: "33333333-3333-4333-8333-333333333333",
      payload: { phone: "4164560696" } // Canadian edit that couldn't be persisted
    } as never);
    vi.mocked(updateBusinessPhone).mockRejectedValue(new Error("row locked"));

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    // No fee: provisioning would buy a US number from the stale row, so
    // billing must not charge the Canadian surcharge.
    const call = vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0];
    expect(call && "canadaFee" in call).toBe(false);
  });

  it("uses the draft phone without a write when it matches the stored row (coercion-aware: raw draft vs E.164 row)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "+14164560696",
      timezone: "America/Toronto"
    } as never);
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: businessId,
      draft_token: "33333333-3333-4333-8333-333333333333",
      payload: { phone: "4164560696" }
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(updateBusinessPhone).not.toHaveBeenCalled();
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "monthly" }
      })
    );
  });

  it("never writes an uncoercible legacy-draft phone to the row (classification falls to the timezone signal)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "+16025551234",
      timezone: "America/Toronto"
    } as never);
    // Pre-validation draft carrying a 7-digit fragment (the KYP Ads shape).
    vi.mocked(getOnboardingDraft).mockResolvedValue({
      business_id: businessId,
      draft_token: "33333333-3333-4333-8333-333333333333",
      payload: { phone: "5188192" }
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(updateBusinessPhone).not.toHaveBeenCalled();
    // The junk phone yields no NPA, so detection falls through to the
    // Canadian timezone → fee still applies.
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "monthly" }
      })
    );
  });

  it("falls back to the business row when the draft read fails (never blocks checkout)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "4164560696",
      timezone: "America/Toronto"
    } as never);
    vi.mocked(getOnboardingDraft).mockRejectedValue(new Error("draft table down"));

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        draftToken: "33333333-3333-4333-8333-333333333333"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        canadaFee: { monthlyCents: 499, billingPeriod: "monthly" }
      })
    );
  });

  it("prefers the stored row timezone over the caller-supplied one", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(getBusiness).mockResolvedValue({
      id: businessId,
      owner_email: `pending+${businessId}@onboarding.local`,
      phone: "+447911123456",
      timezone: "America/Phoenix" // stored US timezone wins
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "starter",
        businessId,
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com",
        signupUserId,
        timezone: "America/Toronto"
      })
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const call = vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0];
    expect(call && "canadaFee" in call).toBe(false);
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

  it("blocks checkout with 409 when the posted business already has a live subscription", async () => {
    // The "Amy reset" guard: a stale onboarding draft resuming an existing
    // businessId must not shadow that business's active subscription with a
    // fresh pending row.
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(findCheckoutBlockingSubscription).mockResolvedValue({
      id: "sub-live",
      business_id: businessId,
      status: "active"
    } as never);

    const request = new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: "standard",
        businessId,
        billingPeriod: "biennial",
        ownerEmail: "owner@example.com",
        signupUserId
      })
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/billing page/i);
    expect(findCheckoutBlockingSubscription).toHaveBeenCalledWith([businessId]);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("checks every business owned by an authenticated user, not just the posted one", async () => {
    const otherBusinessId = "44444444-4444-4444-8444-444444444444";
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: signupUserId,
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(listBusinessIdsByOwnerEmail).mockResolvedValue([otherBusinessId]);
    vi.mocked(findCheckoutBlockingSubscription).mockResolvedValue({
      id: "sub-live",
      business_id: otherBusinessId,
      status: "active"
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

    expect(response.status).toBe(409);
    expect(listBusinessIdsByOwnerEmail).toHaveBeenCalledWith("owner@example.com");
    expect(findCheckoutBlockingSubscription).toHaveBeenCalledWith(
      expect.arrayContaining([businessId, otherBusinessId])
    );
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when the live-subscription guard read throws", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    vi.mocked(verifySignupIdentity).mockResolvedValue(true);
    vi.mocked(findCheckoutBlockingSubscription).mockRejectedValue(new Error("db read timeout"));

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

    expect(response.status).toBe(500);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
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
