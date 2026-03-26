import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStripe, verifyWebhook, createCheckoutSession, resolvePriceId } from "@/lib/stripe/client";

const mockConstructEvent = vi.fn();
const mockSessionCreate = vi.fn();

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: mockSessionCreate
      }
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
      STRIPE_WEBHOOK_SECRET: "whsec_mock",
      STRIPE_STARTER_PRICE_ID: "price_mock_starter",
      STRIPE_STANDARD_PRICE_ID: "price_mock_standard"
    };
    mockConstructEvent.mockReturnValue({ id: "evt_mock", type: "checkout.session.completed" });
    mockSessionCreate.mockResolvedValue({ id: "cs_mock_session", url: "https://checkout.stripe.com/mock" });
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
      metadata: { businessId: "uuid-123" }
    });
    expect(result.id).toBe("cs_mock_session");
    expect(result.url).toContain("stripe.com");
  });

  it("createCheckoutSession works without optional fields", async () => {
    const result = await createCheckoutSession({
      priceId: "price_mock",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel"
    });
    expect(result.id).toBeDefined();
  });

  it("resolvePriceId returns starter price", () => {
    expect(resolvePriceId("starter")).toBe("price_mock_starter");
  });

  it("resolvePriceId returns standard price", () => {
    expect(resolvePriceId("standard")).toBe("price_mock_standard");
  });

  it("resolvePriceId throws when env var missing", () => {
    delete process.env.STRIPE_STARTER_PRICE_ID;
    expect(() => resolvePriceId("starter")).toThrow("not configured");
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
});
