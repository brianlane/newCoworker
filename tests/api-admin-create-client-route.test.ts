import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  createBusiness: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  createSubscription: vi.fn()
}));

import { POST } from "@/app/api/admin/create-client/route";
import { requireAdmin } from "@/lib/auth";
import { createBusiness } from "@/lib/db/businesses";
import { createSubscription } from "@/lib/db/subscriptions";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/create-client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const BASE_BODY = {
  name: "Acme Corp",
  ownerEmail: "owner@acme.com"
};

describe("api/admin/create-client route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(createBusiness).mockImplementation(
      async (data) => ({ id: data.id }) as never
    );
    vi.mocked(createSubscription).mockResolvedValue({} as never);
  });

  it("creates a business + active Stripe-less subscription", async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, tier: "standard" }));
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "standard", vpsSize: null })
    );
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "standard",
        status: "active",
        stripe_customer_id: null,
        stripe_subscription_id: null
      })
    );
  });

  it("passes an enterprise hardware pin through to createBusiness", async () => {
    const res = await POST(
      makeRequest({ ...BASE_BODY, tier: "enterprise", vpsSize: "kvm4" })
    );
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "enterprise", vpsSize: "kvm4" })
    );
  });

  it("enterprise without a pin defaults vpsSize to null (tier default at provision time)", async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, tier: "enterprise" }));
    expect(res.status).toBe(200);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "enterprise", vpsSize: null })
    );
  });

  it("rejects an invalid vpsSize", async () => {
    const res = await POST(
      makeRequest({ ...BASE_BODY, tier: "enterprise", vpsSize: "kvm999" })
    );
    expect(res.status).toBe(400);
    expect(createBusiness).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("rejects an invalid tier", async () => {
    const res = await POST(makeRequest({ ...BASE_BODY, tier: "platinum" }));
    expect(res.status).toBe(400);
    expect(createBusiness).not.toHaveBeenCalled();
  });

  it("requires admin auth", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Unauthorized"));
    const res = await POST(makeRequest({ ...BASE_BODY, tier: "starter" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createBusiness).not.toHaveBeenCalled();
  });
});
