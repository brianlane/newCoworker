import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn(),
  createSubscription: vi.fn(),
  updateSubscription: vi.fn()
}));

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn()
}));

import { POST } from "@/app/api/admin/skip-payment/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  getSubscription,
  createSubscription,
  updateSubscription
} from "@/lib/db/subscriptions";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(): Request {
  return new Request("http://localhost/api/admin/skip-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BIZ_ID })
  });
}

const BIZ = {
  id: BIZ_ID,
  name: "Corp",
  owner_email: "o@o.com",
  tier: "enterprise",
  status: "offline",
  hostinger_vps_id: null,
  vps_size: "kvm4",
  created_at: "2026-01-01T00:00:00Z"
};

describe("api/admin/skip-payment route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(BIZ as never);
    vi.mocked(orchestrateProvisioning).mockResolvedValue({
      vpsId: "42",
      tunnelUrl: "https://x.newcoworker.com",
      hostingerBillingSubscriptionId: null
    });
  });

  it("activates an existing subscription and provisions at its committed term", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "sub-1",
      status: "pending",
      billing_period: "annual"
    } as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith("sub-1", { status: "active" });
    expect(createSubscription).not.toHaveBeenCalled();
    // The committed term flows through so the Hostinger box is bought at the
    // matching term SKU, not expensive monthly renewal.
    expect(orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ_ID,
        tier: "enterprise",
        vpsSize: "kvm4",
        billingPeriod: "annual"
      })
    );
  });

  it("creates a Stripe-less active subscription when none exists and provisions monthly", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        tier: "enterprise",
        status: "active",
        stripe_customer_id: null,
        stripe_subscription_id: null
      })
    );
    expect(orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ billingPeriod: null })
    );
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
  });
});
