import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  findAuthUserIdByEmail: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle", () => ({
  planLifecycleAction: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { DELETE } from "@/app/api/admin/delete-client/route";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest() {
  return new Request("http://localhost/api/admin/delete-client", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BUSINESS_ID })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({
    userId: "admin-1",
    email: "admin@example.com",
    isAdmin: true
  } as never);
  vi.mocked(getBusiness).mockResolvedValue({
    id: BUSINESS_ID,
    owner_email: "owner@example.com",
    status: "online",
    tier: "standard",
    hostinger_vps_id: "42",
    customer_profile_id: "prof-1"
  } as never);
  vi.mocked(findAuthUserIdByEmail).mockResolvedValue("auth-owner-1");
  vi.mocked(loadLifecycleContextForBusiness).mockResolvedValue({
    ok: true,
    vpsHost: "1.2.3.4",
    context: {
      subscription: {
        id: "sub-1",
        business_id: BUSINESS_ID,
        customer_profile_id: "prof-1",
        stripe_subscription_id: "sub_stripe",
        status: "active"
      } as never,
      ownerEmail: "owner@example.com",
      ownerAuthUserId: "auth-owner-1",
      profile: null,
      virtualMachineId: 42,
      vpsHost: "1.2.3.4"
    }
  } as never);
  vi.mocked(planLifecycleAction).mockReturnValue({
    ok: true,
    plan: {
      stripeOps: [],
      hostingerOps: [],
      sshOps: [],
      dbUpdates: [],
      emailsToSend: []
    }
  } as never);
  vi.mocked(executeLifecyclePlan).mockResolvedValue({} as never);
});

describe("api/admin/delete-client route (adminForceCancel)", () => {
  it("dispatches adminForceCancel and returns deleted=true", async () => {
    const response = await DELETE(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { deleted: true }
    });

    expect(planLifecycleAction).toHaveBeenCalledWith(
      { type: "adminForceCancel" },
      expect.objectContaining({ ownerAuthUserId: "auth-owner-1" })
    );
    expect(executeLifecyclePlan).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        businessId: BUSINESS_ID,
        vpsHost: "1.2.3.4",
        customerProfileId: "prof-1"
      })
    );
  });

  it("returns 404 when the business is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(404);
    expect(planLifecycleAction).not.toHaveBeenCalled();
    expect(executeLifecyclePlan).not.toHaveBeenCalled();
  });

  it("returns 404 when the lifecycle context cannot be loaded", async () => {
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "no_subscription"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(404);
    expect(planLifecycleAction).not.toHaveBeenCalled();
  });

  it("returns 409 when the planner rejects the action", async () => {
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: false,
      reason: "subscription_already_canceled"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(409);
    expect(executeLifecyclePlan).not.toHaveBeenCalled();
  });

  it("rejects malformed businessId with 400 VALIDATION_ERROR", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/admin/delete-client", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: "not-a-uuid" })
      })
    );
    expect(response.status).toBe(400);
  });
});
