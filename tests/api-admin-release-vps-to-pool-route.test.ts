import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));
vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));
vi.mock("@/lib/db/vps-inventory", () => ({
  releaseVpsToPool: vi.fn()
}));

import { POST } from "@/app/api/admin/vps/[businessId]/release-to-pool/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import { releaseVpsToPool } from "@/lib/db/vps-inventory";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(): Request {
  return new Request(`http://localhost/api/admin/vps/${BIZ_ID}/release-to-pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
}

function makeCtx(businessId: string = BIZ_ID) {
  return { params: Promise.resolve({ businessId }) };
}

const baseBiz = {
  id: BIZ_ID,
  name: "Test Biz",
  owner_email: "owner@example.com",
  tier: "standard" as const,
  status: "offline" as const,
  hostinger_vps_id: "1806114",
  vps_size: null,
  vps_provider: "hostinger",
  created_at: "2026-03-31T00:00:00Z"
};

describe("api/admin/vps/[businessId]/release-to-pool route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(baseBiz as never);
    vi.mocked(getSubscription).mockResolvedValue(null);
    vi.mocked(releaseVpsToPool).mockResolvedValue(undefined);
  });

  it("releases the box to the pool with the pinned hardware plan and admin-stamped notes", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ ...baseBiz, vps_size: "kvm2" } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ released: true, vmId: 1806114, plan: "kvm2" });

    expect(releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1806114,
        plan: "kvm2",
        hostingerBillingSubscriptionId: null,
        notes: expect.stringContaining("released to pool by admin admin@example.com")
      })
    );
  });

  it("derives the LEGACY deployed size (kvm8) for an unpinned standard tenant", async () => {
    // vps_size null on a standard tenant = pre-pin era box, which was
    // deployed on kvm8 hardware — the pool plan must describe the real
    // hardware or the adopt-first size match would hand a kvm8 box to a
    // kvm2 signup.
    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ released: true, vmId: 1806114, plan: "kvm8" });
  });

  it("passes the subscription's Hostinger billing id through for canceled subscriptions", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "canceled",
      hostinger_billing_subscription_id: "hsub-1"
    } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(200);
    expect(releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerBillingSubscriptionId: "hsub-1" })
    );
  });

  it("409s while the subscription is active (would cascade-delete a paying tenant)", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "active",
      hostinger_billing_subscription_id: null
    } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(409);
    expect(releaseVpsToPool).not.toHaveBeenCalled();
  });

  it("409s while the subscription is past_due", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      status: "past_due",
      hostinger_billing_subscription_id: null
    } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(409);
    expect(releaseVpsToPool).not.toHaveBeenCalled();
  });

  it("400s for non-Hostinger providers (BYOS boxes are not pool stock)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ ...baseBiz, vps_provider: "byos" } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(400);
    expect(releaseVpsToPool).not.toHaveBeenCalled();
  });

  it("400s when the business has no Hostinger VPS", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ ...baseBiz, hostinger_vps_id: null } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toMatch(/no Hostinger VPS/);
  });

  it("400s when hostinger_vps_id is non-numeric (byos sentinel etc.)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      ...baseBiz,
      hostinger_vps_id: "byos-abc"
    } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(400);
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(404);
  });

  it("400s on a malformed businessId param", async () => {
    const res = await POST(makeRequest(), makeCtx("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("falls back to the admin userId in notes when the admin has no email", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-uid-9",
      email: null,
      isAdmin: true
    } as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(200);
    expect(releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ notes: expect.stringContaining("admin admin-uid-9") })
    );
  });

  it("surfaces unexpected errors via handleRouteError", async () => {
    vi.mocked(releaseVpsToPool).mockRejectedValue(new Error("pool db down"));

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(500);
  });
});
