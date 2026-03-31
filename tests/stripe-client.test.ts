import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStripe,
  verifyWebhook,
  createCheckoutSession,
  createCustomerPortalSession,
  ensureCommitmentSchedule,
  resolveStripePublishableKey,
  resolveIntroDiscountCouponId,
  resolvePriceId,
  resolveRenewalPriceId
} from "@/lib/stripe/client";

const mockConstructEvent = vi.fn();
const mockSessionCreate = vi.fn();
const mockPortalSessionCreate = vi.fn();
const mockSubscriptionRetrieve = vi.fn();
const mockScheduleCreate = vi.fn();
const mockScheduleRetrieve = vi.fn();
const mockScheduleUpdate = vi.fn();

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: mockSessionCreate
      }
    };
    billingPortal = {
      sessions: {
        create: mockPortalSessionCreate
      }
    };
    subscriptions = {
      retrieve: mockSubscriptionRetrieve
    };
    subscriptionSchedules = {
      create: mockScheduleCreate,
      retrieve: mockScheduleRetrieve,
      update: mockScheduleUpdate
    };
    webhooks = {
      constructEvent: mockConstructEvent
    };
  }
  return { default: MockStripe };
});

describe("stripe/client", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_PUBLISHABLE_KEY: "pk_test_mock",
      STRIPE_WEBHOOK_SECRET: "whsec_mock",
      STRIPE_STARTER_24MO_PRICE_ID: "price_starter_24mo",
      STRIPE_STARTER_24MO_RENEWAL_PRICE_ID: "price_starter_24mo_renewal",
      STRIPE_STARTER_12MO_PRICE_ID: "price_starter_12mo",
      STRIPE_STARTER_12MO_RENEWAL_PRICE_ID: "price_starter_12mo_renewal",
      STRIPE_STARTER_1MO_PRICE_ID: "price_starter_1mo",
      STRIPE_STARTER_1MO_INTRO_COUPON_ID: "coupon_starter_1mo_intro",
      STRIPE_STANDARD_24MO_PRICE_ID: "price_standard_24mo",
      STRIPE_STANDARD_24MO_RENEWAL_PRICE_ID: "price_standard_24mo_renewal",
      STRIPE_STANDARD_12MO_PRICE_ID: "price_standard_12mo",
      STRIPE_STANDARD_12MO_RENEWAL_PRICE_ID: "price_standard_12mo_renewal",
      STRIPE_STANDARD_1MO_PRICE_ID: "price_standard_1mo",
      STRIPE_STANDARD_1MO_INTRO_COUPON_ID: "coupon_standard_1mo_intro"
    };
    mockConstructEvent.mockReturnValue({ id: "evt_mock", type: "checkout.session.completed" });
    mockSessionCreate.mockResolvedValue({ id: "cs_mock_session", url: "https://checkout.stripe.com/mock" });
    mockPortalSessionCreate.mockResolvedValue({ url: "https://billing.stripe.com/session/mock" });
    mockSubscriptionRetrieve.mockResolvedValue({
      schedule: null,
      items: {
        data: [
          {
            price: { id: "price_starter_24mo" },
            quantity: 1
          }
        ]
      }
    });
    mockScheduleCreate.mockResolvedValue({
      id: "sub_sched_123",
      current_phase: {
        start_date: 1700000000,
        end_date: 1702592000
      },
      phases: []
    });
    mockScheduleRetrieve.mockResolvedValue({
      id: "sub_sched_existing",
      current_phase: {
        start_date: 1700000000,
        end_date: 1702592000
      },
      phases: []
    });
    mockScheduleUpdate.mockResolvedValue({ id: "sub_sched_123" });
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.clearAllMocks();
  });

  it("getStripe returns a Stripe instance with configured key", () => {
    const stripe = getStripe();
    expect(stripe).toBeDefined();
  });

  it("getStripe throws when no key configured", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => getStripe()).toThrow("STRIPE_SECRET_KEY is not configured");
  });

  it("getStripe accepts explicit secretKey", () => {
    const stripe = getStripe("sk_test_explicit");
    expect(stripe).toBeDefined();
  });

  it("resolveStripePublishableKey prefers NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_public";
    expect(resolveStripePublishableKey()).toBe("pk_test_public");
  });

  it("resolveStripePublishableKey falls back to STRIPE_PUBLISHABLE_KEY", () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    expect(resolveStripePublishableKey()).toBe("pk_test_mock");
  });

  it("createCustomerPortalSession returns portal url", async () => {
    const result = await createCustomerPortalSession({
      customerId: "cus_123",
      returnUrl: "https://example.com/dashboard/settings"
    });
    expect(result.url).toContain("billing.stripe.com");
    expect(mockPortalSessionCreate).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://example.com/dashboard/settings"
    });
  });

  it("verifyWebhook returns event on valid signature", () => {
    const event = verifyWebhook("payload", "signature");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("verifyWebhook throws when STRIPE_WEBHOOK_SECRET missing", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => verifyWebhook("payload", "signature")).toThrow(
      "STRIPE_WEBHOOK_SECRET is not configured"
    );
  });

  it("createCheckoutSession returns id and url", async () => {
    const result = await createCheckoutSession({
      priceId: "price_mock_starter",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      customerEmail: "test@test.com",
      metadata: { businessId: "uuid-123" },
      discountCouponId: "coupon_intro"
    });
    expect(result.id).toBe("cs_mock_session");
    expect(result.url).toContain("stripe.com");
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        billing_address_collection: "auto",
        discounts: [{ coupon: "coupon_intro" }]
      })
    );
  });

  it("createCheckoutSession works without optional fields", async () => {
    const result = await createCheckoutSession({
      priceId: "price_mock",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel"
    });
    expect(result.id).toBeDefined();
  });

  it("resolvePriceId defaults to biennial when no period given", () => {
    expect(resolvePriceId("starter")).toBe("price_starter_24mo");
  });

  it("resolvePriceId returns starter biennial price", () => {
    expect(resolvePriceId("starter", "biennial")).toBe("price_starter_24mo");
  });

  it("resolvePriceId returns starter annual price", () => {
    expect(resolvePriceId("starter", "annual")).toBe("price_starter_12mo");
  });

  it("resolvePriceId returns starter monthly price", () => {
    expect(resolvePriceId("starter", "monthly")).toBe("price_starter_1mo");
  });

  it("resolvePriceId returns standard biennial price", () => {
    expect(resolvePriceId("standard", "biennial")).toBe("price_standard_24mo");
  });

  it("resolvePriceId returns standard annual price", () => {
    expect(resolvePriceId("standard", "annual")).toBe("price_standard_12mo");
  });

  it("resolvePriceId returns standard monthly price", () => {
    expect(resolvePriceId("standard", "monthly")).toBe("price_standard_1mo");
  });

  it("resolveIntroDiscountCouponId returns monthly starter coupon", () => {
    expect(resolveIntroDiscountCouponId("starter", "monthly")).toBe("coupon_starter_1mo_intro");
  });

  it("resolveIntroDiscountCouponId returns undefined for non-monthly periods", () => {
    expect(resolveIntroDiscountCouponId("starter", "annual")).toBeUndefined();
  });

  it("resolveRenewalPriceId returns starter biennial renewal price", () => {
    expect(resolveRenewalPriceId("starter", "biennial")).toBe("price_starter_24mo_renewal");
  });

  it("resolveIntroDiscountCouponId throws when monthly coupon env var missing", () => {
    delete process.env.STRIPE_STARTER_1MO_INTRO_COUPON_ID;
    expect(() => resolveIntroDiscountCouponId("starter", "monthly")).toThrow("not configured");
  });

  it("resolvePriceId throws when env var missing", () => {
    delete process.env.STRIPE_STARTER_24MO_PRICE_ID;
    expect(() => resolvePriceId("starter", "biennial")).toThrow("not configured");
  });

  it("verifyWebhook wraps Error instance in message", () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    expect(() => verifyWebhook("payload", "sig")).toThrow("Webhook signature verification failed: bad signature");
  });

  it("verifyWebhook wraps non-Error thrown value in message", () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw "non-error string";
    });
    expect(() => verifyWebhook("payload", "sig")).toThrow("Webhook signature verification failed: non-error string");
  });

  it("createCheckoutSession throws when session url is null", async () => {
    mockSessionCreate.mockResolvedValueOnce({ id: "cs_null", url: null });
    await expect(createCheckoutSession({
      priceId: "price_mock_starter",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel"
    })).rejects.toThrow("Stripe checkout session URL is null");
  });

  it("ensureCommitmentSchedule creates and updates a schedule for annual commitments", async () => {
    const scheduleId = await ensureCommitmentSchedule({
      subscriptionId: "sub_123",
      tier: "starter",
      billingPeriod: "annual"
    });

    expect(scheduleId).toBe("sub_sched_123");
    expect(mockScheduleCreate).toHaveBeenCalledWith({ from_subscription: "sub_123" });
    expect(mockScheduleUpdate).toHaveBeenCalledWith(
      "sub_sched_123",
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            start_date: 1700000000,
            end_date: 1702592000,
            items: [{ price: "price_starter_24mo", quantity: 1 }]
          }),
          expect.objectContaining({
            start_date: 1702592000,
            items: [{ price: "price_starter_12mo_renewal", quantity: 1 }]
          })
        ]
      })
    );
  });

  it("ensureCommitmentSchedule skips monthly plans", async () => {
    const result = await ensureCommitmentSchedule({
      subscriptionId: "sub_123",
      tier: "starter",
      billingPeriod: "monthly"
    });

    expect(result).toBeNull();
    expect(mockScheduleCreate).not.toHaveBeenCalled();
  });

  it("ensureCommitmentSchedule returns existing schedule when renewal phase already matches", async () => {
    mockSubscriptionRetrieve.mockResolvedValueOnce({
      schedule: "sub_sched_existing",
      items: {
        data: [
          {
            price: { id: "price_standard_24mo" },
            quantity: 1
          }
        ]
      }
    });
    mockScheduleRetrieve.mockResolvedValueOnce({
      id: "sub_sched_existing",
      current_phase: {
        start_date: 1700000000,
        end_date: 1702592000
      },
      phases: [
        {},
        {
          items: [{ price: { id: "price_standard_24mo_renewal" } }]
        }
      ]
    });

    const result = await ensureCommitmentSchedule({
      subscriptionId: "sub_123",
      tier: "standard",
      billingPeriod: "biennial"
    });

    expect(result).toBe("sub_sched_existing");
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
  });
});
