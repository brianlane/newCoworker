import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Phase 2 (agency): the route resolves the ACTIVE business through the
// cookie-aware helper; pin it to a fixed id here, the supabase chain mock
// below still decides which rows come back, so existing fixtures keep
// driving each scenario.
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111")
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

// Payer identity under admin view-as. Default is "not impersonating", so the
// existing fixtures keep describing an ordinary owner checking out.
vi.mock("@/lib/admin/view-as", () => ({
  resolveViewAsTargetUser: vi.fn()
}));

vi.mock("@/lib/stripe/client", () => ({
  createChatCreditCheckoutSession: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

import { POST } from "@/app/api/billing/chat-credit/checkout/route";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { createChatCreditCheckoutSession } from "@/lib/stripe/client";
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
  return new Request("http://localhost:3000/api/billing/chat-credit/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/billing/chat-credit/checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      STRIPE_CHAT_CREDIT_5USD_PRICE_ID: "price_chat_5",
      STRIPE_CHAT_CREDIT_10USD_PRICE_ID: "price_chat_10",
      STRIPE_CHAT_CREDIT_25USD_PRICE_ID: "price_chat_25"
    };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: UID,
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: UID,
      email: "owner@example.com",
      impersonating: false
    });
    mockBusinessesQuery([{ id: BID }]);
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);
    vi.mocked(createChatCreditCheckoutSession).mockResolvedValue({
      id: "cs_chat_credit_1",
      url: "https://checkout.stripe.test/chat-credit"
    });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("creates a Checkout Session for a valid pack and returns the URL", async () => {
    const res = await POST(buildRequest({ packId: "usd_5" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.checkoutUrl).toBe("https://checkout.stripe.test/chat-credit");
    expect(body.data.sessionId).toBe("cs_chat_credit_1");

    expect(createChatCreditCheckoutSession).toHaveBeenCalledWith({
      priceId: "price_chat_5",
      businessId: BID,
      creditMicros: 5_000_000,
      successUrl:
        "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled",
      customerEmail: "owner@example.com",
      customerId: "cus_123",
      userId: UID
    });
  });

  it("opens Checkout under the TENANT's email when an admin is impersonating", async () => {
    // Payer identity has to follow the business, not the caller. Before this
    // split, removing the view-as refusal left an operator's own address on a
    // customer's Checkout Session (Bugbot High on PR #1420).
    //
    // `userId` deliberately stays the CALLER: its only reader stores it as
    // `consent_user_id` (who authorized the charge), so naming the tenant
    // there would fabricate a consent record.
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "admin-1",
      email: "admin@newcoworker.com",
      isAdmin: true
    } as never);
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "tenant-user-1",
      email: "tenant@example.com",
      impersonating: true
    });

    const res = await POST(buildRequest({ packId: "usd_5" }));
    expect(res.status).toBe(200);
    expect(createChatCreditCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BID,
        customerEmail: "tenant@example.com",
        userId: "admin-1"
      })
    );
  });

  it("falls back to customer_email when there is no Stripe customer", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: null
    } as never);

    const res = await POST(buildRequest({ packId: "usd_25" }));
    expect(res.status).toBe(200);
    expect(createChatCreditCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_chat_25",
        creditMicros: 25_000_000,
        customerId: undefined
      })
    );
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const res = await POST(buildRequest({ packId: "usd_5" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.message).toBe("Authentication required");
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed packId", async () => {
    const res = await POST(buildRequest({ packId: "usd_999" }));
    expect(res.status).toBe(400);
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the pack id is valid but no Price ID is configured", async () => {
    delete process.env.STRIPE_CHAT_CREDIT_10USD_PRICE_ID;

    const res = await POST(buildRequest({ packId: "usd_10" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Chat credit pack is not available");
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller has no business", async () => {
    mockBusinessesQuery([]);

    const res = await POST(buildRequest({ packId: "usd_5" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Business not found");
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business has no active Stripe subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: null,
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "usd_5" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("active subscription");
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the subscription is pending / past_due", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "pending",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "usd_5" }));
    expect(res.status).toBe(409);
    expect(createChatCreditCheckoutSession).not.toHaveBeenCalled();
  });

  it("propagates unexpected errors as 500", async () => {
    vi.mocked(createChatCreditCheckoutSession).mockRejectedValueOnce(new Error("stripe boom"));

    const res = await POST(buildRequest({ packId: "usd_5" }));
    expect(res.status).toBe(500);
  });

  it("falls back to localhost when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await POST(buildRequest({ packId: "usd_5" }));
    expect(res.status).toBe(200);
    expect(createChatCreditCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl:
          "http://localhost:3000/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "http://localhost:3000/dashboard/billing?bonus=cancelled"
      })
    );
  });
});
