import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/stripe/client", () => ({
  createVoiceBonusCheckoutSession: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

import { POST } from "@/app/api/billing/voice-bonus/checkout/route";
import { getAuthUser } from "@/lib/auth";
import { createVoiceBonusCheckoutSession } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";

const OLD_ENV = process.env;
const BID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";

function mockBusinessesQuery(rows: Array<{ id: string }>) {
  // Route sorts by created_at DESC before limiting, so the mock needs an
  // `order` hop in the chain to match the production query shape.
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null })
  } as never);
}

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/billing/voice-bonus/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/billing/voice-bonus/checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      VOICE_BONUS_USD_PER_MINUTE: "0.43",
      STRIPE_VOICE_BONUS_30MIN_PRICE_ID: "price_30",
      STRIPE_VOICE_BONUS_120MIN_PRICE_ID: "price_120",
      STRIPE_VOICE_BONUS_600MIN_PRICE_ID: "price_600"
    };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: UID,
      email: "owner@example.com",
      isAdmin: false
    } as never);
    mockBusinessesQuery([{ id: BID }]);
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);
    vi.mocked(createVoiceBonusCheckoutSession).mockResolvedValue({
      id: "cs_voice_bonus_1",
      url: "https://checkout.stripe.test/voice-bonus"
    });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("creates a Checkout Session for a valid pack and returns the URL", async () => {
    const res = await POST(buildRequest({ packId: "min_30" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.checkoutUrl).toBe("https://checkout.stripe.test/voice-bonus");
    expect(body.data.sessionId).toBe("cs_voice_bonus_1");

    expect(createVoiceBonusCheckoutSession).toHaveBeenCalledWith({
      priceId: "price_30",
      businessId: BID,
      voiceSeconds: 1800,
      successUrl:
        "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled",
      customerEmail: "owner@example.com",
      customerId: "cus_123",
      userId: UID
    });
  });

  it("handles packs where the business has no Stripe customer yet (fall back to customer_email)", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: null
    } as never);

    const res = await POST(buildRequest({ packId: "min_120" }));
    expect(res.status).toBe(200);
    expect(createVoiceBonusCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: "price_120", voiceSeconds: 7200, customerId: undefined })
    );
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const res = await POST(buildRequest({ packId: "min_30" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Authentication required");
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed packId", async () => {
    const res = await POST(buildRequest({ packId: "not-a-pack" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the pack id is valid but no Price ID is configured", async () => {
    delete process.env.STRIPE_VOICE_BONUS_600MIN_PRICE_ID;

    const res = await POST(buildRequest({ packId: "min_600" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("Voice bonus pack is not available");
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller has no business", async () => {
    mockBusinessesQuery([]);

    const res = await POST(buildRequest({ packId: "min_30" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Business not found");
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business has no active Stripe subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: null,
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "min_30" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("active subscription");
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the subscription is pending / past_due", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "past_due",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "min_30" }));
    expect(res.status).toBe(409);
    expect(createVoiceBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("propagates unexpected errors as 500", async () => {
    vi.mocked(createVoiceBonusCheckoutSession).mockRejectedValueOnce(new Error("stripe boom"));

    const res = await POST(buildRequest({ packId: "min_30" }));
    expect(res.status).toBe(500);
  });

  it("falls back to localhost when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await POST(buildRequest({ packId: "min_30" }));
    expect(res.status).toBe(200);
    expect(createVoiceBonusCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl:
          "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled"
      })
    );
  });
});
