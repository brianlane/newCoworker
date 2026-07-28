import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn(),
  updateSubscription: vi.fn()
}));
vi.mock("@/lib/stripe/client", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));

import { POST } from "@/app/api/admin/billing-pause/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { getStripe } from "@/lib/stripe/client";
import { logAdminAction } from "@/lib/admin/audit";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/billing-pause", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BIZ_ID, ...body })
  });
}

const stripeUpdate = vi.fn();

describe("api/admin/billing-pause route", () => {
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
      pause_collection: { behavior: "void" }
    });
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: { update: stripeUpdate }
    } as never);
  });

  it("pauses collection and mirrors the state Stripe returned", async () => {
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(200);
    expect(stripeUpdate).toHaveBeenCalledWith("sub_stripe_1", {
      pause_collection: { behavior: "void" }
    });
    expect(updateSubscription).toHaveBeenCalledWith("sub-row-1", {
      billing_paused: true,
      billing_pause_resumes_at: null
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing_pause", businessId: BIZ_ID })
    );
  });

  it("passes an auto-resume date through to Stripe", async () => {
    const resumesAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    stripeUpdate.mockResolvedValue({
      pause_collection: {
        behavior: "void",
        resumes_at: Math.floor(Date.parse(resumesAt) / 1000)
      }
    });

    const res = await POST(makeRequest({ action: "pause", resumesAt }));
    expect(res.status).toBe(200);
    expect(stripeUpdate).toHaveBeenCalledWith("sub_stripe_1", {
      pause_collection: {
        behavior: "void",
        resumes_at: Math.floor(Date.parse(resumesAt) / 1000)
      }
    });
    expect(updateSubscription).toHaveBeenCalledWith(
      "sub-row-1",
      expect.objectContaining({ billing_paused: true })
    );
  });

  it("resumes by clearing pause_collection", async () => {
    stripeUpdate.mockResolvedValue({ pause_collection: null });
    const res = await POST(makeRequest({ action: "resume" }));
    expect(res.status).toBe(200);
    expect(stripeUpdate).toHaveBeenCalledWith("sub_stripe_1", { pause_collection: null });
    expect(updateSubscription).toHaveBeenCalledWith("sub-row-1", {
      billing_paused: false,
      billing_pause_resumes_at: null
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing_resume" })
    );
  });

  it("rejects a resume date in the past before calling Stripe", async () => {
    const res = await POST(
      makeRequest({ action: "pause", resumesAt: "2020-01-01T00:00:00.000Z" })
    );
    expect(res.status).toBe(400);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(404);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("404s when there is no subscription row", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(404);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("409s on a non-active subscription", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "canceled",
      stripe_subscription_id: "sub_stripe_1"
    } as never);
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: "subscription_not_active" }
    });
  });

  it("409s on a Stripe-less subscription: there is no collection to pause", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-row-1",
      status: "active",
      stripe_subscription_id: null
    } as never);
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(409);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it("500s without touching the row when Stripe rejects the update", async () => {
    stripeUpdate.mockRejectedValue(new Error("No such subscription: sub_stripe_1"));
    const res = await POST(makeRequest({ action: "pause" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: { message: "No such subscription: sub_stripe_1" }
    });
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("400s on an unknown action", async () => {
    const res = await POST(makeRequest({ action: "obliterate" }));
    expect(res.status).toBe(400);
    expect(stripeUpdate).not.toHaveBeenCalled();
  });
});
