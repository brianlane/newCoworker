import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecyclePlan, LifecyclePlanResult } from "@/lib/billing/lifecycle";

const {
  getAuthUserMock,
  supabaseFromMock,
  loadLifecycleContextMock,
  planLifecycleActionMock,
  executeLifecyclePlanMock,
  executeLifecyclePlanFastPhaseMock,
  executeLifecyclePlanSlowPhaseMock,
  loadBillableUsageCarveOutCentsMock,
  resolveUsageCarveOutWindowMock,
  resolveViewAsTargetUserMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  loadLifecycleContextMock: vi.fn(),
  planLifecycleActionMock: vi.fn(),
  executeLifecyclePlanMock: vi.fn(),
  executeLifecyclePlanFastPhaseMock: vi.fn(),
  executeLifecyclePlanSlowPhaseMock: vi.fn(),
  loadBillableUsageCarveOutCentsMock: vi.fn(),
  resolveUsageCarveOutWindowMock: vi.fn(),
  resolveViewAsTargetUserMock: vi.fn()
}));

// `after()` from `next/server` requires the Next.js work-units context
// (only present inside the actual Next runtime). In tests we run the
// route handler bare, so polyfill it to invoke the callback on
// `queueMicrotask`, close enough to "after the response" for assertions
// that need the slow phase to have executed.
// Phase 2 (agency): the route resolves the ACTIVE business through the
// cookie-aware helper; pin it to a fixed id here, the supabase chain mock
// below still decides which rows come back, so existing fixtures keep
// driving each scenario.
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111")
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => void | Promise<void>) => {
      queueMicrotask(() => {
        try {
          const result = cb();
          if (result && typeof (result as Promise<unknown>).then === "function") {
            (result as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          // Test polyfill: errors are intentionally swallowed; the route
          // handler's own try/catch is what tests assert on.
        }
      });
    }
  };
});

vi.mock("@/lib/auth", () => ({
  getAuthUser: getAuthUserMock
}));

// Payer identity under admin view-as. Default is "not impersonating", so the
// existing fixtures keep describing an owner cancelling their own plan.
vi.mock("@/lib/admin/view-as", () => ({
  resolveViewAsTargetUser: resolveViewAsTargetUserMock
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

vi.mock("@/lib/billing/usage-charges", () => ({
  loadBillableUsageCarveOutCents: loadBillableUsageCarveOutCentsMock,
  resolveUsageCarveOutWindow: resolveUsageCarveOutWindowMock
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
    telnyxOps: [],
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
    telnyxOps: [],
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
    resolveViewAsTargetUserMock.mockResolvedValue({
      userId: "user_1",
      email: "owner@example.com",
      impersonating: false
    });
    supabaseFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
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
    resolveUsageCarveOutWindowMock.mockReturnValue({
      ok: true,
      window: {
        sinceIso: "2026-05-01T00:00:00.000Z",
        aiSpendSinceIso: "2026-05-01T00:00:00.000Z"
      }
    });
    loadBillableUsageCarveOutCentsMock.mockResolvedValue({
      usage: { smsSent: 0, smsReceived: 0, voiceSeconds: 0, aiSpendMicros: 0 },
      cents: 0
    });
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
      in: vi.fn().mockReturnThis(),
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

  it("hands the lifecycle planner the TENANT's login under view-as, not the operator's", async () => {
    // The worst version of the caller-identity bug this route could carry.
    // `ownerAuthUserId` is what the planner turns into a `delete_auth_user`
    // op, so an operator cancelling a customer's plan with their own id here
    // would queue deletion of the OPERATOR's account (Bugbot High on
    // PR #1420). The business already resolves through the view-as pin; the
    // login has to follow it.
    getAuthUserMock.mockResolvedValue({
      userId: "admin-1",
      email: "admin@newcoworker.com",
      isAdmin: true
    });
    resolveViewAsTargetUserMock.mockResolvedValue({
      userId: "tenant-user-1",
      email: "tenant@example.com",
      impersonating: true
    });

    await POST(req({ mode: "period_end" }));
    expect(loadLifecycleContextMock).toHaveBeenCalledWith(
      "biz_1",
      expect.objectContaining({ ownerAuthUserId: "tenant-user-1" })
    );
  });

  it("passes no ownerAuthUserId when the impersonated tenant has no login", async () => {
    // A pending/placeholder owner_email. undefined makes the planner SKIP the
    // auth-user op entirely, which is the safe outcome: falling back to the
    // caller would delete the operator's login instead.
    getAuthUserMock.mockResolvedValue({
      userId: "admin-1",
      email: "admin@newcoworker.com",
      isAdmin: true
    });
    resolveViewAsTargetUserMock.mockResolvedValue({
      userId: null,
      email: "pending-x@example.com",
      impersonating: true
    });

    await POST(req({ mode: "period_end" }));
    expect(loadLifecycleContextMock).toHaveBeenCalledWith(
      "biz_1",
      expect.objectContaining({ ownerAuthUserId: undefined })
    );
  });

  it("refund mode is refused for Canadian/BYOS placements (Terms §9 exclusion)", async () => {
    // OVH (Canada) and BYOS tenants are excluded from the self-serve
    // 30-day guarantee, the underlying OVH box is non-refundable to the
    // platform. period_end cancellation stays available.
    for (const vpsProvider of ["ovh", "byos"]) {
      loadLifecycleContextMock.mockResolvedValueOnce({
        ok: true,
        vpsHost: "1.2.3.4",
        context: { ...makeContext(), vpsProvider }
      });
      const res = await POST(req({ mode: "refund" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error.message).toBe("refund_not_available_for_placement");
    }
    expect(planLifecycleActionMock).not.toHaveBeenCalled();

    // period_end for the same placement still works.
    loadLifecycleContextMock.mockResolvedValueOnce({
      ok: true,
      vpsHost: "1.2.3.4",
      context: { ...makeContext(), vpsProvider: "ovh" }
    });
    planLifecycleActionMock.mockReturnValueOnce({
      ok: true,
      plan: periodEndPlan()
    } satisfies LifecyclePlanResult);
    const periodEnd = await POST(req({ mode: "period_end" }));
    expect(periodEnd.status).toBe(200);
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

  it("period_end path stamps DB via fast phase before Hostinger renewal toggle", async () => {
    planLifecycleActionMock.mockReturnValueOnce({
      ok: true,
      plan: periodEndPlan()
    } satisfies LifecyclePlanResult);
    executeLifecyclePlanFastPhaseMock.mockResolvedValueOnce({});

    const res = await POST(req({ mode: "period_end" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ mode: "period_end", graceEndsAt: null });
    expect(executeLifecyclePlanFastPhaseMock).toHaveBeenCalledTimes(1);
    expect(executeLifecyclePlanMock).toHaveBeenCalledTimes(1);
    expect(executeLifecyclePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [],
        dbUpdates: [],
        sshOps: [],
        telnyxOps: []
      }),
      expect.any(Object)
    );
    expect(executeLifecyclePlanSlowPhaseMock).not.toHaveBeenCalled();
  });

  it("period_end path returns 500 if the executor throws", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: periodEndPlan() });
    executeLifecyclePlanFastPhaseMock.mockRejectedValueOnce(new Error("stripe 500"));
    const res = await POST(req({ mode: "period_end" }));
    expect(res.status).toBe(500);
  });

  it("period_end path returns 500 if Hostinger renewal disable throws", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: periodEndPlan() });
    executeLifecyclePlanFastPhaseMock.mockResolvedValueOnce({});
    executeLifecyclePlanMock.mockRejectedValueOnce(new Error("hostinger 500"));
    const res = await POST(req({ mode: "period_end" }));
    expect(res.status).toBe(500);
  });

  it("refund path runs fast phase synchronously and schedules slow phase post-response", async () => {
    const plan = refundPlan();
    planLifecycleActionMock.mockReturnValue({ ok: true, plan });
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

  it("refund mode threads the billable-usage carve-out into the final planner context", async () => {
    loadBillableUsageCarveOutCentsMock.mockResolvedValueOnce({
      usage: { smsSent: 40, smsReceived: 12, voiceSeconds: 600, aiSpendMicros: 500_000 },
      cents: 142
    });
    // Called twice: eligibility validation, then the final plan with the
    // loaded carve-out threaded in.
    planLifecycleActionMock.mockReturnValue({ ok: true, plan: refundPlan() });

    const res = await POST(req({ mode: "refund" }));

    expect(res.status).toBe(200);
    expect(loadBillableUsageCarveOutCentsMock).toHaveBeenCalledWith("biz_1", {
      sinceIso: "2026-05-01T00:00:00.000Z",
      aiSpendSinceIso: "2026-05-01T00:00:00.000Z"
    });
    expect(planLifecycleActionMock).toHaveBeenCalledTimes(2);
    expect(planLifecycleActionMock).toHaveBeenLastCalledWith(
      { type: "cancelWithRefund" },
      expect.objectContaining({ billableUsageCents: 142 })
    );
  });

  it("refund mode fails closed (500, no execution) when the usage read errors", async () => {
    planLifecycleActionMock.mockReturnValue({ ok: true, plan: refundPlan() });
    loadBillableUsageCarveOutCentsMock.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(500);
    expect(executeLifecyclePlanFastPhaseMock).not.toHaveBeenCalled();
  });

  it("refund mode returns 409 when the usage window cannot be resolved (eligible but cold cache)", async () => {
    planLifecycleActionMock.mockReturnValue({ ok: true, plan: refundPlan() });
    resolveUsageCarveOutWindowMock.mockReturnValueOnce({
      ok: false,
      reason: "usage_window_unknown"
    });
    const res = await POST(req({ mode: "refund" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("usage_window_unknown");
    expect(loadBillableUsageCarveOutCentsMock).not.toHaveBeenCalled();
    expect(executeLifecyclePlanFastPhaseMock).not.toHaveBeenCalled();
  });

  it("ineligible refunds get the planner's typed error, never usage_window_unknown", async () => {
    // Eligibility is validated BEFORE the usage window is resolved, so a
    // closed refund window surfaces as refund_window_closed even when the
    // usage window would also be unresolvable.
    planLifecycleActionMock.mockReturnValueOnce({
      ok: false,
      reason: "refund_window_closed"
    } satisfies LifecyclePlanResult);
    const res = await POST(req({ mode: "refund" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("refund_window_closed");
    expect(resolveUsageCarveOutWindowMock).not.toHaveBeenCalled();
    expect(loadBillableUsageCarveOutCentsMock).not.toHaveBeenCalled();
  });

  it("period_end mode never loads the usage carve-out", async () => {
    planLifecycleActionMock.mockReturnValueOnce({ ok: true, plan: periodEndPlan() });
    const res = await POST(req({ mode: "period_end" }));
    expect(res.status).toBe(200);
    expect(loadBillableUsageCarveOutCentsMock).not.toHaveBeenCalled();
  });

  it("refund path returns 500 if the fast phase throws (slow phase never kicks off)", async () => {
    planLifecycleActionMock.mockReturnValue({ ok: true, plan: refundPlan() });
    executeLifecyclePlanFastPhaseMock.mockRejectedValueOnce(new Error("stripe refund 500"));
    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(500);
    expect(executeLifecyclePlanSlowPhaseMock).not.toHaveBeenCalled();
  });

  it("refund path swallows background slow-phase failures so the HTTP response still succeeds", async () => {
    planLifecycleActionMock.mockReturnValue({ ok: true, plan: refundPlan() });
    executeLifecyclePlanFastPhaseMock.mockResolvedValueOnce({});
    executeLifecyclePlanSlowPhaseMock.mockRejectedValueOnce(new Error("hostinger 500"));

    const res = await POST(req({ mode: "refund" }));
    expect(res.status).toBe(200);

    // Wait for the background catch to run so the test doesn't leak an
    // unhandled rejection between runs.
    await new Promise((r) => setImmediate(r));
  });

  it("refund path falls back to graceEndsAt: null when the plan has no update_subscription op", async () => {
    planLifecycleActionMock.mockReturnValue({
      ok: true,
      plan: { stripeOps: [], sshOps: [], hostingerOps: [], telnyxOps: [], dbUpdates: [], emailsToSend: [] }
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
