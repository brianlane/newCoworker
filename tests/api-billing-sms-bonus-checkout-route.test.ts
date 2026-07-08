import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/stripe/client", () => ({
  createSmsBonusCheckoutSession: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

import { POST } from "@/app/api/billing/sms-bonus/checkout/route";
import { getAuthUser } from "@/lib/auth";
import { createSmsBonusCheckoutSession } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";

const OLD_ENV = process.env;
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
  return new Request("http://localhost:3000/api/billing/sms-bonus/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/billing/sms-bonus/checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      STRIPE_SMS_BONUS_500_PRICE_ID: "price_sms_500",
      STRIPE_SMS_BONUS_2000_PRICE_ID: "price_sms_2000",
      STRIPE_SMS_BONUS_10000_PRICE_ID: "price_sms_10000"
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
    vi.mocked(createSmsBonusCheckoutSession).mockResolvedValue({
      id: "cs_sms_bonus_1",
      url: "https://checkout.stripe.test/sms-bonus"
    });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("creates a Checkout Session for a valid pack and returns the URL", async () => {
    const res = await POST(buildRequest({ packId: "texts_500" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.checkoutUrl).toBe("https://checkout.stripe.test/sms-bonus");
    expect(body.data.sessionId).toBe("cs_sms_bonus_1");

    expect(createSmsBonusCheckoutSession).toHaveBeenCalledWith({
      priceId: "price_sms_500",
      businessId: BID,
      smsTexts: 500,
      successUrl:
        "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled",
      customerEmail: "owner@example.com",
      customerId: "cus_123",
      userId: UID
    });
  });

  it("falls back to customer_email when there is no Stripe customer", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: null
    } as never);

    const res = await POST(buildRequest({ packId: "texts_2000" }));
    expect(res.status).toBe(200);
    expect(createSmsBonusCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: "price_sms_2000", smsTexts: 2000, customerId: undefined })
    );
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const res = await POST(buildRequest({ packId: "texts_500" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.message).toBe("Authentication required");
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed packId", async () => {
    const res = await POST(buildRequest({ packId: "not-a-pack" }));
    expect(res.status).toBe(400);
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the pack id is valid but no Price ID is configured", async () => {
    delete process.env.STRIPE_SMS_BONUS_10000_PRICE_ID;

    const res = await POST(buildRequest({ packId: "texts_10000" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("SMS bonus pack is not available");
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller has no business", async () => {
    mockBusinessesQuery([]);

    const res = await POST(buildRequest({ packId: "texts_500" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Business not found");
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business has no active Stripe subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: null,
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "texts_500" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("active subscription");
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the subscription is pending / past_due", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "past_due",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "texts_500" }));
    expect(res.status).toBe(409);
    expect(createSmsBonusCheckoutSession).not.toHaveBeenCalled();
  });

  it("propagates unexpected errors as 500", async () => {
    vi.mocked(createSmsBonusCheckoutSession).mockRejectedValueOnce(new Error("stripe boom"));

    const res = await POST(buildRequest({ packId: "texts_500" }));
    expect(res.status).toBe(500);
  });

  it("falls back to localhost when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await POST(buildRequest({ packId: "texts_500" }));
    expect(res.status).toBe(200);
    expect(createSmsBonusCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl:
          "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled"
      })
    );
  });
});
