import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/billing/resubscribe-checkout", () => ({
  createAdminResubscribeCheckout: vi.fn()
}));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/admin/resubscribe-checkout/route";
import { requireAdmin } from "@/lib/auth";
import { createAdminResubscribeCheckout } from "@/lib/billing/resubscribe-checkout";
import { logAdminAction } from "@/lib/admin/audit";

const BIZ = "6cc2d7ba-a007-49d4-93a4-586967e147f1";

function request(body: unknown) {
  return new Request("https://example.com/api/admin/resubscribe-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/admin/resubscribe-checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ email: "ops@example.com" } as never);
  });

  it("returns the Checkout url and audits the issue", async () => {
    vi.mocked(createAdminResubscribeCheckout).mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/resub",
      sessionId: "cs_live_resub",
      tier: "standard",
      billingPeriod: "monthly",
      ownerEmail: "selena@example.com"
    });

    const res = await POST(request({ businessId: BIZ }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.url).toBe("https://checkout.stripe.com/resub");
    expect(json.data.tier).toBe("standard");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resubscribe_checkout_issued",
        businessId: BIZ,
        detail: expect.objectContaining({ sessionId: "cs_live_resub" })
      })
    );
  });

  it("surfaces a grace-window refusal as 409", async () => {
    vi.mocked(createAdminResubscribeCheckout).mockResolvedValue({
      ok: false,
      refusal: "subscription_not_in_grace",
      message: "Resubscribe Checkout is only available during the data-retention grace window."
    });

    const res = await POST(request({ businessId: BIZ }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.message).toMatch(/grace/i);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resubscribe_checkout_refused",
        detail: { refusal: "subscription_not_in_grace" }
      })
    );
  });

  it("rejects a malformed business id", async () => {
    const res = await POST(request({ businessId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(createAdminResubscribeCheckout).not.toHaveBeenCalled();
  });

  it("passes tier and billingPeriod overrides through", async () => {
    vi.mocked(createAdminResubscribeCheckout).mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/x",
      sessionId: "cs_1",
      tier: "starter",
      billingPeriod: "annual",
      ownerEmail: "selena@example.com"
    });
    await POST(request({ businessId: BIZ, tier: "starter", billingPeriod: "annual" }));
    expect(createAdminResubscribeCheckout).toHaveBeenCalledWith({
      businessId: BIZ,
      tier: "starter",
      billingPeriod: "annual"
    });
  });

  it("refuses a non-admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createAdminResubscribeCheckout).not.toHaveBeenCalled();
  });
});
