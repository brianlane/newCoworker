import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/subscriptions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/subscriptions")>(
    "@/lib/db/subscriptions"
  );
  return {
    // The period-cache mapper is pure, so exercise the real one: the route's
    // job is to persist exactly what Stripe reported.
    stripeSubscriptionPeriodCache: actual.stripeSubscriptionPeriodCache,
    getSubscription: vi.fn(),
    updateSubscription: vi.fn()
  };
});
vi.mock("@/lib/stripe/client", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));

import { POST } from "@/app/api/admin/billing-date/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { getStripe } from "@/lib/stripe/client";
import { logAdminAction } from "@/lib/admin/audit";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ISO = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const NEXT_UNIX = Math.floor(Date.parse(NEXT_ISO) / 1000);

function makeRequest(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/admin/billing-date", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BIZ_ID, nextBillingAt: NEXT_ISO, ...body })
  });
}

const stripeUpdate = vi.fn();

describe("api/admin/billing-date route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, name: "Corp" } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "active",
      stripe_subscription_id: "sub_stripe_1"
    } as never);
    stripeUpdate.mockResolvedValue({
      id: "sub_stripe_1",
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: NEXT_UNIX
    });
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: { update: stripeUpdate }
    } as never);
  });

  it("moves the anchor with no proration and refreshes the period cache", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(stripeUpdate).toHaveBeenCalledWith("sub_stripe_1", {
      trial_end: NEXT_UNIX,
      proration_behavior: "none"
    });
    expect(updateSubscription).toHaveBeenCalledWith(
      "sub-row-1",
      expect.objectContaining({
        stripe_current_period_end: new Date(NEXT_UNIX * 1000).toISOString()
      })
    );
    expect(await res.json()).toMatchObject({
      data: { nextBillingAt: new Date(NEXT_UNIX * 1000).toISOString() }
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "set_next_billing_date", businessId: BIZ_ID })
    );
  });

  it("still audits when Stripe returns no period bounds", async () => {
    stripeUpdate.mockResolvedValue({ id: "sub_stripe_1" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ data: { nextBillingAt: null } });
    expect(logAdminAction).toHaveBeenCalled();
  });

  it("rejects a past date before calling Stripe", async () => {
    const res = await POST(makeRequest({ nextBillingAt: "2020-01-01T00:00:00.000Z" }));
    expect(res.status).toBe(400);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
  });

  it("404s when there is no subscription row", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
  });

  it("409s on a non-active subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "pending",
      stripe_subscription_id: "sub_stripe_1"
    } as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("409s on a Stripe-less subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "active",
      stripe_subscription_id: null
    } as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("translates the schedule-managed Stripe rejection into operator language", async () => {
    stripeUpdate.mockRejectedValue(
      new Error("Cannot update `trial_end` on a subscription managed by a schedule.")
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.message).toContain("commitment schedule");
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("400s when nextBillingAt is missing", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/billing-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: BIZ_ID })
      })
    );
    expect(res.status).toBe(400);
  });
});
