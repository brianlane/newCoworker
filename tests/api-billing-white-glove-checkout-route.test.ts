import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/stripe/client", () => ({
  createWhiteGloveCheckoutSession: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

import { POST } from "@/app/api/billing/white-glove/checkout/route";
import { getAuthUser } from "@/lib/auth";
import { createWhiteGloveCheckoutSession } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";

const OLD_ENV = process.env;
const BID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";

function mockBusinessesQuery(rows: Array<{ id: string; white_glove_package: string | null }>) {
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null })
  } as never);
}

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/billing/white-glove/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/billing/white-glove/checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000"
    };
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: UID,
      email: "owner@example.com",
      isAdmin: false
    } as never);
    mockBusinessesQuery([{ id: BID, white_glove_package: null }]);
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);
    vi.mocked(createWhiteGloveCheckoutSession).mockResolvedValue({
      id: "cs_white_glove_1",
      url: "https://checkout.stripe.test/white-glove"
    });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("creates a Checkout Session for a valid package and returns the URL", async () => {
    const res = await POST(buildRequest({ packId: "setup" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.checkoutUrl).toBe("https://checkout.stripe.test/white-glove");
    expect(body.data.sessionId).toBe("cs_white_glove_1");

    expect(createWhiteGloveCheckoutSession).toHaveBeenCalledWith({
      packageId: "setup",
      packageName: "White-glove setup",
      amountCents: 75_000,
      businessId: BID,
      successUrl:
        "http://localhost:3000/dashboard/billing?whiteGlove=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://localhost:3000/dashboard/billing?whiteGlove=cancelled",
      customerEmail: "owner@example.com",
      customerId: "cus_123",
      userId: UID
    });
  });

  it("allows upgrading from setup to buildout", async () => {
    mockBusinessesQuery([{ id: BID, white_glove_package: "setup" }]);

    const res = await POST(buildRequest({ packId: "buildout" }));
    expect(res.status).toBe(200);
    expect(createWhiteGloveCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: "buildout", amountCents: 200_000 })
    );
  });

  it("falls back to customer_email when there is no Stripe customer", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: null
    } as never);

    const res = await POST(buildRequest({ packId: "buildout" }));
    expect(res.status).toBe(200);
    expect(createWhiteGloveCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: "buildout", customerId: undefined })
    );
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);

    const res = await POST(buildRequest({ packId: "setup" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.message).toBe("Authentication required");
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed packId", async () => {
    const res = await POST(buildRequest({ packId: "platinum" }));
    expect(res.status).toBe(400);
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller has no business", async () => {
    mockBusinessesQuery([]);

    const res = await POST(buildRequest({ packId: "setup" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe("Business not found");
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business already owns the requested package", async () => {
    mockBusinessesQuery([{ id: BID, white_glove_package: "setup" }]);

    const res = await POST(buildRequest({ packId: "setup" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("already has this white-glove package");
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business owns buildout and requests setup", async () => {
    mockBusinessesQuery([{ id: BID, white_glove_package: "buildout" }]);

    const res = await POST(buildRequest({ packId: "setup" }));
    expect(res.status).toBe(409);
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the business has no active Stripe subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      stripe_subscription_id: null,
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "setup" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.message).toContain("active subscription");
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 409 when the subscription is pending / past_due", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "past_due",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123"
    } as never);

    const res = await POST(buildRequest({ packId: "setup" }));
    expect(res.status).toBe(409);
    expect(createWhiteGloveCheckoutSession).not.toHaveBeenCalled();
  });

  it("propagates unexpected errors as 500", async () => {
    vi.mocked(createWhiteGloveCheckoutSession).mockRejectedValueOnce(new Error("stripe boom"));

    const res = await POST(buildRequest({ packId: "setup" }));
    expect(res.status).toBe(500);
  });

  it("falls back to localhost when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await POST(buildRequest({ packId: "setup" }));
    expect(res.status).toBe(200);
    expect(createWhiteGloveCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl:
          "http://localhost:3000/dashboard/billing?whiteGlove=success&session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "http://localhost:3000/dashboard/billing?whiteGlove=cancelled"
      })
    );
  });
});
