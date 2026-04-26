import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecyclePlan, LifecyclePlanResult } from "@/lib/billing/lifecycle";

const {
  getAuthUserMock,
  supabaseFromMock,
  loadLifecycleContextMock,
  planLifecycleActionMock,
  executeLifecyclePlanMock,
  executeLifecyclePlanFastPhaseMock,
  executeLifecyclePlanSlowPhaseMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  loadLifecycleContextMock: vi.fn(),
  planLifecycleActionMock: vi.fn(),
  executeLifecyclePlanMock: vi.fn(),
  executeLifecyclePlanFastPhaseMock: vi.fn(),
  executeLifecyclePlanSlowPhaseMock: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: getAuthUserMock
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({
    from: supabaseFromMock
  })
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: loadLifecycleContextMock
}));

vi.mock("@/lib/billing/lifecycle", () => ({
  planLifecycleAction: planLifecycleActionMock
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: executeLifecyclePlanMock,
  executeLifecyclePlanFastPhase: executeLifecyclePlanFastPhaseMock,
  executeLifecyclePlanSlowPhase: executeLifecyclePlanSlowPhaseMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import { POST } from "@/app/api/billing/cancel/route";

function makeContext() {
  return {
    subscription: {
      id: "sub_row_1",
      business_id: "biz_1",
      status: "active",
      customer_profile_id: "prof_1"
    },
    profile: { id: "prof_1" },
    ownerEmail: "owner@example.com",
    ownerAuthUserId: "user_1",
    virtualMachineId: 42,
    vpsHost: "1.2.3.4"
  };
}

function refundPlan(): LifecyclePlan {
  return {
    stripeOps: [],
    sshOps: [],
    hostingerOps: [],
    dbUpdates: [
      {
        type: "update_subscription",
        subscriptionId: "sub_row_1",
        patch: { status: "canceled", grace_ends_at: "2026-06-01T00:00:00.000Z" }
      }
    ],
    emailsToSend: []
  };
}

function periodEndPlan(): LifecyclePlan {
  return {
    stripeOps: [],
    sshOps: [],
    hostingerOps: [],
    dbUpdates: [
      {
        type: "update_subscription",
        subscriptionId: "sub_row_1",
        patch: { cancel_at_period_end: true }
      }
    ],
    emailsToSend: []
  };
}

describe("/api/billing/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUserMock.mockResolvedValue({
      userId: "user_1",
      email: "owner@example.com",
      isAdmin: false
    });
    supabaseFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ id: "biz_1" }], error: null })
    });
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: makeContext()
    });
    executeLifecyclePlanMock.mockResolvedValue({});
    executeLifecyclePlanFastPhaseMock.mockResolvedValue({});
    executeLifecyclePlanSlowPhaseMock.mockResolvedValue(undefined);
  });

  function req(body: unknown): Request {
    return new Request("http://localhost/api/billing/cancel", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  it("rejects unauthenticated callers", async () => {
    getAuthUserMock.mockResolvedValueOnce(null);
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid mode", async () => {
    const res = await POST(req({ mode: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the caller has no business row", async () => {
    supabaseFromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null })
    });
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the lifecycle context cannot be loaded", async () => {
    loadLifecycleContextMock.mockResolvedValueOnce({ ok: false, reason: "subscription_not_found" });
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(404);
  });

  it("surfaces planner rejections as 409 with the typed reason", async () => {
    planLifecycleActionMock.mockReturnValueOnce({
      ok: false,
      reason: "refund_window_closed"
    } satisfies LifecyclePlanResult);
    const res = await POST(req({ mode: "refund" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("refund_window_closed");
  });

  it("period_end path uses the all-in-one executor and returns graceEndsAt: null", async () => {
    planLifecycleActionMock.mockReturnValueOnce({
      ok: true,
      plan: periodEndPlan()
    } satisfies LifecyclePlanResult);

    const res = await POST(req({ mode: "period_end" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ mode: "period_end", graceEndsAt: null });
    expect(executeLifecyclePlanMock).toHaveBeenCalledTimes(1);
    expect(executeLifecyclePlanFastPhaseMock).not.toHaveBeenCalled();
    expect(executeLifecyclePlanSlowPhaseMock).not.toHaveBeenCalled();
  });

  it("period_end path returns 500 if the executor throws", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: periodEndPlan() });
    executeLifecyclePlanMock.mockRejectedValueOnce(new Error("stripe 500"));
    const res = await POST(req({ mode: "period_end" }));
    expect(res.status).toBe(500);
  });

  it("refund path runs fast phase synchronously and schedules slow phase post-response", async () => {
    const plan = refundPlan();
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan });
    executeLifecyclePlanFastPhaseMock.mockResolvedValueOnce({
      refund: { stripeRefundId: "re_1", stripeChargeId: "ch_1", amountCents: 2500 }
    });

    const res = await POST(req({ mode: "refund" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      mode: "refund",
      graceEndsAt: "2026-06-01T00:00:00.000Z"
    });

    expect(executeLifecyclePlanFastPhaseMock).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({ businessId: "biz_1", customerProfileId: "prof_1" })
    );
    // Slow phase is fire-and-forget; allow the microtask queue to settle.
    await new Promise((r) => setImmediate(r));
    expect(executeLifecyclePlanSlowPhaseMock).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({
        refund: expect.objectContaining({ stripeRefundId: "re_1" })
      })
    );
  });

  it("refund path returns 500 if the fast phase throws (slow phase never kicks off)", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: refundPlan() });
    executeLifecyclePlanFastPhaseMock.mockRejectedValueOnce(new Error("stripe refund 500"));
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(500);
    expect(executeLifecyclePlanSlowPhaseMock).not.toHaveBeenCalled();
  });

  it("refund path swallows background slow-phase failures so the HTTP response still succeeds", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: refundPlan() });
    executeLifecyclePlanFastPhaseMock.mockResolvedValueOnce({});
    executeLifecyclePlanSlowPhaseMock.mockRejectedValueOnce(new Error("hostinger 500"));

    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(200);

    // Wait for the background catch to run so the test doesn't leak an
    // unhandled rejection between runs.
    await new Promise((r) => setImmediate(r));
  });

  it("refund path falls back to graceEndsAt: null when the plan has no update_subscription op", async () => {
    planLifecycleActionMock.mockReturnValueOnce({
      ok: true,
      plan: { stripeOps: [], sshOps: [], hostingerOps: [], dbUpdates: [], emailsToSend: [] }
    });
    const res = await POST(req({ mode: "refund" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.graceEndsAt).toBeNull();
  });

  it("handles unexpected errors via handleRouteError", async () => {
    getAuthUserMock.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
