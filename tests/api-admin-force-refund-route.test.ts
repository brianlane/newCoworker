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

import { POST } from "@/app/api/admin/force-refund/route";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest() {
  return new Request("http://localhost/api/admin/force-refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: BUSINESS_ID })
  });
}

const defaultCtx = {
  ok: true as const,
  vpsHost: "1.2.3.4",
  context: {
    subscription: {
      id: "sub-1",
      business_id: BUSINESS_ID,
      customer_profile_id: "prof-1",
      stripe_subscription_id: "sub_stripe",
      status: "active"
    },
    ownerEmail: "owner@example.com",
    ownerAuthUserId: "auth-1",
    profile: null,
    virtualMachineId: 42,
    vpsHost: "1.2.3.4"
  }
};

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
  vi.mocked(loadLifecycleContextForBusiness).mockResolvedValue(defaultCtx as never);
  vi.mocked(executeLifecyclePlan).mockResolvedValue({} as never);
});

describe("api/admin/force-refund route", () => {
  it("runs cancelWithRefund directly when the planner accepts it", async () => {
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: true,
      plan: {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [],
        emailsToSend: []
      }
    } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { refunded: true } });

    expect(planLifecycleAction).toHaveBeenCalledWith(
      { type: "cancelWithRefund" },
      expect.anything()
    );
    expect(planLifecycleAction).toHaveBeenCalledTimes(1);
    expect(executeLifecyclePlan).toHaveBeenCalled();
  });

  it("retries with a synthetic profile when the refund window has closed", async () => {
    vi.mocked(planLifecycleAction)
      .mockReturnValueOnce({ ok: false, reason: "refund_window_closed" } as never)
      .mockReturnValueOnce({
        ok: true,
        plan: {
          stripeOps: [],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [],
          emailsToSend: []
        }
      } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(planLifecycleAction).toHaveBeenCalledTimes(2);
    const secondCallCtx = (planLifecycleAction as unknown as { mock: { calls: [unknown, { profile: { refund_used_at: string | null; first_paid_at: string | null } }][] } })
      .mock.calls[1][1];
    expect(secondCallCtx.profile.refund_used_at).toBeNull();
    expect(secondCallCtx.profile.first_paid_at).not.toBeNull();
    expect(executeLifecyclePlan).toHaveBeenCalled();
  });

  it("retries with a synthetic profile when the refund was already used", async () => {
    vi.mocked(planLifecycleAction)
      .mockReturnValueOnce({ ok: false, reason: "refund_already_used" } as never)
      .mockReturnValueOnce({
        ok: true,
        plan: {
          stripeOps: [],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [],
          emailsToSend: []
        }
      } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(planLifecycleAction).toHaveBeenCalledTimes(2);
  });

  it("surfaces structural planner rejections as 409", async () => {
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: false,
      reason: "no_stripe_subscription"
    } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(409);
    expect(executeLifecyclePlan).not.toHaveBeenCalled();
  });

  it("returns 404 when the business is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    const response = await POST(makeRequest());
    expect(response.status).toBe(404);
  });
});
