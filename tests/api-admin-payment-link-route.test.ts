import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/billing/signup-payment-link", () => ({ createSignupPaymentLink: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/admin/payment-link/route";
import { requireAdmin } from "@/lib/auth";
import { createSignupPaymentLink } from "@/lib/billing/signup-payment-link";
import { logAdminAction } from "@/lib/admin/audit";

const BIZ = "a912aff5-dd87-49fb-ad6a-477acefb66c0";

function request(body: unknown) {
  return new Request("https://example.com/api/admin/payment-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/admin/payment-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ email: "newcoworkerteam@gmail.com" } as never);
  });

  it("returns the link and records who issued it", async () => {
    vi.mocked(createSignupPaymentLink).mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/x",
      sessionId: "cs_live_1",
      tier: "standard",
      billingPeriod: "monthly",
      ownerEmail: "king@kinintegrated.com",
      reusedPendingSubscription: true
    });

    const res = await POST(request({ businessId: BIZ }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.url).toBe("https://checkout.stripe.com/x");
    expect(json.data.ownerEmail).toBe("king@kinintegrated.com");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment_link_issued", businessId: BIZ })
    );
  });

  // A refusal is a rule working, so it reports the rule's own wording and is
  // still audited: "why did this not produce a link" needs an answer.
  it("surfaces a refusal as a 409 with its reason, and audits it", async () => {
    vi.mocked(createSignupPaymentLink).mockResolvedValue({
      ok: false,
      refusal: "already_subscribed",
      message: "This account already has live service."
    });

    const res = await POST(request({ businessId: BIZ }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.message).toContain("already has live service");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment_link_refused",
        detail: { refusal: "already_subscribed" }
      })
    );
  });

  it("rejects a malformed business id", async () => {
    const res = await POST(request({ businessId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(createSignupPaymentLink).not.toHaveBeenCalled();
  });

  it("passes an explicit owner email through", async () => {
    vi.mocked(createSignupPaymentLink).mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/x",
      sessionId: "cs_live_1",
      tier: "standard",
      billingPeriod: "monthly",
      ownerEmail: "other@example.com",
      reusedPendingSubscription: false
    });

    await POST(request({ businessId: BIZ, ownerEmail: "other@example.com" }));

    expect(createSignupPaymentLink).toHaveBeenCalledWith({
      businessId: BIZ,
      ownerEmail: "other@example.com"
    });
  });

  it("refuses a non-admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
    const res = await POST(request({ businessId: BIZ }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(createSignupPaymentLink).not.toHaveBeenCalled();
  });
});
