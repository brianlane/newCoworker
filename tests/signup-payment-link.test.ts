import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/client", () => ({
  resolvePriceId: vi.fn((tier: string, period: string) => `price_${tier}_${period}`),
  resolveIntroDiscountCouponId: vi.fn(() => undefined),
  createCheckoutSession: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  createSignupPaymentLink,
  type SignupPaymentLinkDeps
} from "@/lib/billing/signup-payment-link";
import { LIFETIME_SUBSCRIPTION_CAP } from "@/lib/db/customer-profiles";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";

const BIZ = "a912aff5-dd87-49fb-ad6a-477acefb66c0";

function business(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: BIZ,
    name: "KIN Integrated Child Health",
    // The shape this exists for: never finished checkout, so still the sentinel.
    owner_email: `pending+${BIZ}@onboarding.local`,
    tier: "standard",
    status: "offline",
    hostinger_vps_id: null,
    created_at: "2026-08-21T21:35:34.393Z",
    phone: "+17807076365",
    timezone: "America/Edmonton",
    customer_profile_id: "profile-1",
    ...overrides
  } as BusinessRow;
}

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-row-1",
    business_id: BIZ,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    tier: "standard",
    status: "pending",
    billing_period: "monthly",
    customer_profile_id: "profile-1",
    ...overrides
  } as SubscriptionRow;
}

/** The Stripe params the module handed to createCheckoutSession. */
function sessionParams(deps: SignupPaymentLinkDeps): Record<string, unknown> {
  const mock = deps.createSession as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][0] as Record<string, unknown>;
}

function makeDeps(overrides: Partial<SignupPaymentLinkDeps> = {}): SignupPaymentLinkDeps {
  return {
    getBusinessRow: vi.fn(async () => business()) as never,
    getSubscriptionRow: vi.fn(async () => subscription()) as never,
    findBlocking: vi.fn(async () => null) as never,
    authUserExists: vi.fn(async () => false) as never,
    getProfile: vi.fn(async () => ({
      id: "profile-1",
      normalized_email: "king@kinintegrated.com",
      lifetime_subscription_count: 0
    })) as never,
    createSession: vi.fn(async () => ({ id: "cs_live_1", url: "https://checkout.stripe.com/x" })) as never,
    createSubscriptionRow: vi.fn(async () => subscription()) as never,
    appUrl: "https://www.newcoworker.com",
    ...overrides
  };
}

describe("createSignupPaymentLink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a link for an abandoned signup, billing the profile's real email", async () => {
    const deps = makeDeps();
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);

    expect(result).toMatchObject({
      ok: true,
      url: "https://checkout.stripe.com/x",
      sessionId: "cs_live_1",
      tier: "standard",
      billingPeriod: "monthly",
      // Recovered from the customer profile, because the row is still the
      // pending sentinel. This is the whole point of the fallback.
      ownerEmail: "king@kinintegrated.com",
      reusedPendingSubscription: true
    });
  });

  // Re-issuing must not stack pending rows: the Stripe webhook resolves
  // newest-first, so each extra row would orphan the last one.
  it("reuses the existing pending subscription instead of inserting another", async () => {
    const deps = makeDeps();
    await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(deps.createSubscriptionRow).not.toHaveBeenCalled();
  });

  it("creates a pending subscription when the signup has none", async () => {
    const deps = makeDeps({ getSubscriptionRow: vi.fn(async () => null) as never });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);

    expect(deps.createSubscriptionRow).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: BIZ, status: "pending", tier: "standard" })
    );
    expect(result).toMatchObject({ ok: true, reusedPendingSubscription: false });
  });

  it("creates a pending row when the only subscription is not pending", async () => {
    const deps = makeDeps({
      getSubscriptionRow: vi.fn(async () => subscription({ status: "canceled" })) as never
    });
    await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(deps.createSubscriptionRow).toHaveBeenCalled();
  });

  it("charges the Canadian surcharge and the carrier fee for a Canadian signup", async () => {
    const deps = makeDeps();
    await createSignupPaymentLink({ businessId: BIZ }, deps);

    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_standard_monthly",
        customerEmail: "king@kinintegrated.com",
        canadaFee: { monthlyCents: CANADA_MESSAGING_FEE_MONTHLY_CENTS, billingPeriod: "monthly" },
        oneTimeCarrierFeeCents: CARRIER_REGISTRATION_FEE_CENTS,
        cancelUrl: "https://www.newcoworker.com/pricing",
        metadata: expect.objectContaining({ businessId: BIZ, reissued: "1", canadianMessagingFee: "1" })
      })
    );
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ mexicoFee: expect.anything() })
    );
  });

  it("waives the US carrier fee for a Mexican signup and adds its surcharge", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () =>
        business({ phone: "+525512345678", timezone: "America/Mexico_City" })
      ) as never
    });
    await createSignupPaymentLink({ businessId: BIZ }, deps);

    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        oneTimeCarrierFeeCents: 0,
        mexicoFee: { monthlyCents: MEXICO_MESSAGING_FEE_MONTHLY_CENTS, billingPeriod: "monthly" }
      })
    );
  });

  it("adds no country surcharge for a US signup", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () =>
        business({ phone: "+16025550147", timezone: "America/Phoenix" })
      ) as never
    });
    await createSignupPaymentLink({ businessId: BIZ }, deps);

    const params = sessionParams(deps);
    expect(params.canadaFee).toBeUndefined();
    expect(params.mexicoFee).toBeUndefined();
    expect(params.oneTimeCarrierFeeCents).toBe(CARRIER_REGISTRATION_FEE_CENTS);
  });

  it("keeps the customer's own plan choice rather than re-quoting them", async () => {
    const deps = makeDeps({
      getSubscriptionRow: vi.fn(async () =>
        subscription({ tier: "starter", billing_period: "annual" })
      ) as never
    });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: true, tier: "starter", billingPeriod: "annual" });
  });

  it("falls back to the business tier and the default term with no subscription", async () => {
    const deps = makeDeps({ getSubscriptionRow: vi.fn(async () => null) as never });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: true, tier: "standard", billingPeriod: "biennial" });
  });

  it("lets the caller override tier, period, and billing email", async () => {
    const deps = makeDeps();
    const result = await createSignupPaymentLink(
      { businessId: BIZ, tier: "starter", billingPeriod: "annual", ownerEmail: "other@example.com" },
      deps
    );
    expect(result).toMatchObject({
      ok: true,
      tier: "starter",
      billingPeriod: "annual",
      ownerEmail: "other@example.com"
    });
  });

  it("prefers a real row email over the profile", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () => business({ owner_email: "owner@kin.com" })) as never
    });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: true, ownerEmail: "owner@kin.com" });
  });

  it("refuses when the business does not exist", async () => {
    const deps = makeDeps({ getBusinessRow: vi.fn(async () => null) as never });
    expect(await createSignupPaymentLink({ businessId: BIZ }, deps)).toMatchObject({
      ok: false,
      refusal: "business_not_found"
    });
  });

  it("refuses enterprise, which is invoiced rather than checked out", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () => business({ tier: "enterprise" })) as never,
      getSubscriptionRow: vi.fn(async () => subscription({ tier: "enterprise" })) as never
    });
    expect(await createSignupPaymentLink({ businessId: BIZ }, deps)).toMatchObject({
      ok: false,
      refusal: "tier_not_self_serve"
    });
  });

  it("refuses when the account already has live service", async () => {
    const deps = makeDeps({
      findBlocking: vi.fn(async () => subscription({ status: "active" })) as never
    });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: false, refusal: "already_subscribed" });
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it("refuses when the owner email already has a login", async () => {
    const deps = makeDeps({ authUserExists: vi.fn(async () => true) as never });
    expect(await createSignupPaymentLink({ businessId: BIZ }, deps)).toMatchObject({
      ok: false,
      refusal: "account_exists"
    });
  });

  // An admin-issued or agent-issued link must not be a way around the cap.
  it("refuses when the profile has spent its lifetime subscriptions", async () => {
    const deps = makeDeps({
      getProfile: vi.fn(async () => ({
        id: "profile-1",
        normalized_email: "king@kinintegrated.com",
        lifetime_subscription_count: LIFETIME_SUBSCRIPTION_CAP
      })) as never
    });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: false, refusal: "lifetime_cap" });
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it("refuses when there is no real email anywhere to bill", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () => business({ customer_profile_id: null })) as never,
      getSubscriptionRow: vi.fn(async () =>
        subscription({ customer_profile_id: null })
      ) as never
    });
    const result = await createSignupPaymentLink({ businessId: BIZ }, deps);
    expect(result).toMatchObject({ ok: false, refusal: "no_owner_email" });
    expect(deps.getProfile).not.toHaveBeenCalled();
  });

  // An admin supplying the address by hand for a bare row: no profile to read,
  // and none of the country signals present either.
  it("issues without a profile, and classifies as US when phone and timezone are absent", async () => {
    const deps = makeDeps({
      getBusinessRow: vi.fn(async () =>
        business({ customer_profile_id: null, phone: null, timezone: null })
      ) as never,
      getSubscriptionRow: vi.fn(async () => subscription({ customer_profile_id: null })) as never
    });

    const result = await createSignupPaymentLink(
      { businessId: BIZ, ownerEmail: "typed@byhand.com" },
      deps
    );

    expect(result).toMatchObject({ ok: true, ownerEmail: "typed@byhand.com" });
    const params = sessionParams(deps);
    expect((params.metadata as Record<string, string>).customerProfileId).toBeUndefined();
    expect(params.canadaFee).toBeUndefined();
    expect(params.mexicoFee).toBeUndefined();
  });

  it("refuses when the profile exists but carries no email", async () => {
    const deps = makeDeps({
      getProfile: vi.fn(async () => null) as never
    });
    expect(await createSignupPaymentLink({ businessId: BIZ }, deps)).toMatchObject({
      ok: false,
      refusal: "no_owner_email"
    });
  });
});
