import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn()
}));
vi.mock("@/lib/admin/view-as", () => ({ resolveViewAsTargetUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/billing/priority-support", () => ({
  startPrioritySupport: vi.fn(),
  cancelPrioritySupport: vi.fn()
}));

import { POST, DELETE } from "@/app/api/billing/priority-support/route";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { startPrioritySupport, cancelPrioritySupport } from "@/lib/billing/priority-support";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function mockDb(business: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: vi.fn(self),
    select: vi.fn(self),
    eq: vi.fn(self),
    maybeSingle: vi.fn().mockResolvedValue({ data: business, error: null })
  });
  return chain;
}

function post(body: unknown = {}) {
  return POST(
    new Request("http://localhost/api/billing/priority-support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("api/billing/priority-support route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "user-1",
      email: "owner@test.com",
      isAdmin: false
    } as never);
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(BIZ_ID as never);
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "user-1",
      email: "owner@test.com"
    } as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      mockDb({ id: BIZ_ID, tier: "standard" }) as never
    );
  });

  describe("POST", () => {
    it("returns a checkout url", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: true,
        value: { kind: "checkout", checkoutUrl: "https://pay.test/1" }
      } as never);
      const res = await post();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.checkoutUrl).toBe("https://pay.test/1");
    });

    it("reports a resume with no checkout url, so the client reloads instead", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: true,
        value: { kind: "resumed" }
      } as never);
      const res = await post();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data).toEqual({ resumed: true });
      expect(json.data.checkoutUrl).toBeUndefined();
    });

    it("bills the TENANT under admin view-as, not the operator", async () => {
      // The operator is the caller, but the charge belongs to the tenant, so
      // Checkout must open under the tenant's address.
      vi.mocked(getAuthUser).mockResolvedValue({
        userId: "admin-1",
        email: "admin@newcoworker.com",
        isAdmin: true
      } as never);
      vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
        userId: "user-1",
        email: "tenant@test.com"
      } as never);
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: true,
        value: { kind: "checkout", checkoutUrl: "https://pay.test/1" }
      } as never);

      await post();

      expect(startPrioritySupport).toHaveBeenCalledWith(
        expect.objectContaining({ actorEmail: "tenant@test.com", userId: "admin-1" })
      );
    });

    it("tolerates a request with no body at all", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: true,
        value: { kind: "checkout", checkoutUrl: "https://pay.test/1" }
      } as never);
      const res = await POST(
        new Request("http://localhost/api/billing/priority-support", { method: "POST" })
      );
      expect(res.status).toBe(200);
    });

    it("401s when not signed in", async () => {
      vi.mocked(getAuthUser).mockResolvedValue(null as never);
      expect((await post()).status).toBe(401);
    });

    it("404s when no active business resolves", async () => {
      vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(null as never);
      expect((await post()).status).toBe(404);
    });

    it("404s when the business row is missing", async () => {
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb(null) as never);
      expect((await post()).status).toBe(404);
    });

    it("409s enterprise with a message that says it is already included", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "not_purchasable_for_tier"
      } as never);
      const res = await post();
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.error.message).toMatch(/already include/i);
    });

    it("409s when already subscribed", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "already_subscribed"
      } as never);
      expect((await post()).status).toBe(409);
    });

    it("409s without an active membership", async () => {
      vi.mocked(startPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "no_active_membership"
      } as never);
      expect((await post()).status).toBe(409);
    });

    it("propagates an unexpected failure", async () => {
      vi.mocked(startPrioritySupport).mockRejectedValue(new Error("stripe down"));
      expect((await post()).status).toBeGreaterThanOrEqual(500);
    });
  });

  describe("DELETE", () => {
    it("winds down and reports when coverage ends", async () => {
      vi.mocked(cancelPrioritySupport).mockResolvedValue({
        ok: true,
        value: { coverageEndsAt: "2026-09-17T00:00:00Z" }
      } as never);
      const res = await DELETE();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.data.coverageEndsAt).toBe("2026-09-17T00:00:00Z");
    });

    it("404s when there is nothing to cancel", async () => {
      vi.mocked(cancelPrioritySupport).mockResolvedValue({
        ok: false,
        reason: "not_subscribed"
      } as never);
      expect((await DELETE()).status).toBe(404);
    });

    it("401s when not signed in", async () => {
      vi.mocked(getAuthUser).mockResolvedValue(null as never);
      expect((await DELETE()).status).toBe(401);
    });

    it("propagates an unexpected failure", async () => {
      vi.mocked(cancelPrioritySupport).mockRejectedValue(new Error("stripe down"));
      expect((await DELETE()).status).toBeGreaterThanOrEqual(500);
    });
  });
});
