import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  setPrioritySupportUntil: vi.fn()
}));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/billing/priority-support", () => ({
  startPrioritySupport: vi.fn(),
  cancelPrioritySupport: vi.fn()
}));

import { POST } from "@/app/api/admin/priority-support/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, setPrioritySupportUntil } from "@/lib/db/businesses";
import { logAdminAction } from "@/lib/admin/audit";
import { startPrioritySupport, cancelPrioritySupport } from "@/lib/billing/priority-support";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/priority-support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

function business(tier = "standard") {
  return {
    id: BIZ_ID,
    name: "Corp",
    owner_email: "owner@test.com",
    tier,
    status: "online",
    hostinger_vps_id: null,
    created_at: "2026-01-01T00:00:00Z"
  };
}

describe("api/admin/priority-support route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(business() as never);
  });

  it("404s for an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const res = await post({ businessId: BIZ_ID, action: "pay_link" });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed body", async () => {
    const res = await post({ businessId: "not-a-uuid", action: "pay_link" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    const res = await post({ businessId: BIZ_ID, action: "refund_everything" });
    expect(res.status).toBe(400);
  });

  describe("pay_link", () => {
    it("returns a checkout url and audits it", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: true,
        value: { checkoutUrl: "https://pay.test/1" }
      } as never);
      const res = await post({ businessId: BIZ_ID, action: "pay_link" });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.checkoutUrl).toBe("https://pay.test/1");
      // The OWNER pays, so Checkout must open under their address even though
      // the operator generated the link.
      expect(startPrioritySupport).toHaveBeenCalledWith(
        expect.objectContaining({ actorEmail: "owner@test.com", tier: "standard" })
      );
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "priority_support_pay_link", businessId: BIZ_ID })
      );
    });

    it("refuses enterprise, who already hold a permanent window", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "not_purchasable_for_tier"
      } as never);
      const res = await post({ businessId: BIZ_ID, action: "pay_link" });
      expect(res.status).toBe(400);
      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it("409s when the tenant already has it", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "already_subscribed"
      } as never);
      expect((await post({ businessId: BIZ_ID, action: "pay_link" })).status).toBe(409);
    });

    it("409s when there is no active membership", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "no_active_membership"
      } as never);
      expect((await post({ businessId: BIZ_ID, action: "pay_link" })).status).toBe(409);
    });
  });

  describe("comp", () => {
    it("sets an exact window with the NON-monotonic writer", async () => {
      const res = await post({
        businessId: BIZ_ID,
        action: "comp",
        compUntil: "2026-09-09T00:00:00.000Z"
      });
      expect(res.status).toBe(200);
      // setPrioritySupportUntil, not extendPrioritySupport: an operator must
      // be able to SHORTEN a window, which the payment path refuses to do.
      expect(setPrioritySupportUntil).toHaveBeenCalledWith(
        BIZ_ID,
        new Date("2026-09-09T00:00:00.000Z")
      );
    });

    it("clears the window when compUntil is null", async () => {
      const res = await post({ businessId: BIZ_ID, action: "comp", compUntil: null });
      expect(res.status).toBe(200);
      expect(setPrioritySupportUntil).toHaveBeenCalledWith(BIZ_ID, null);
    });

    it("requires compUntil to be present", async () => {
      const res = await post({ businessId: BIZ_ID, action: "comp" });
      expect(res.status).toBe(400);
      expect(setPrioritySupportUntil).not.toHaveBeenCalled();
    });

    it("refuses a date more than two years out", async () => {
      const farOut = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
      const res = await post({ businessId: BIZ_ID, action: "comp", compUntil: farOut });
      expect(res.status).toBe(400);
      expect(setPrioritySupportUntil).not.toHaveBeenCalled();
    });

    it("audits the comp", async () => {
      await post({ businessId: BIZ_ID, action: "comp", compUntil: "2026-09-09T00:00:00.000Z" });
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "priority_support_comp",
          detail: { until: "2026-09-09T00:00:00.000Z" }
        })
      );
    });
  });

  describe("cancel", () => {
    it("winds the subscription down and audits it", async () => {
      vi.mocked(cancelPrioritySupport).mockResolvedValue({
        ok: true,
        value: { coverageEndsAt: "2026-09-17T00:00:00Z" }
      } as never);
      const res = await post({ businessId: BIZ_ID, action: "cancel" });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.coverageEndsAt).toBe("2026-09-17T00:00:00Z");
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "priority_support_cancel" })
      );
    });

    it("404s when there is nothing to cancel", async () => {
      vi.mocked(cancelPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "not_subscribed"
      } as never);
      const res = await post({ businessId: BIZ_ID, action: "cancel" });
      expect(res.status).toBe(404);
      expect(logAdminAction).not.toHaveBeenCalled();
    });
  });

  it("propagates an unexpected failure through the route error handler", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("db down"));
    const res = await post({ businessId: BIZ_ID, action: "pay_link" });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
