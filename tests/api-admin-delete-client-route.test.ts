import { beforeEach, describe, expect, it, vi } from "vitest";

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => Promise<void> | void) => {
      afterCallbacks.push(cb);
    }
  };
});

async function flushAfterCallbacks(): Promise<void> {
  while (afterCallbacks.length > 0) {
    const cb = afterCallbacks.shift()!;
    await cb();
  }
}

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  findAuthUserIdByEmail: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  deleteBusiness: vi.fn(),
  getBusiness: vi.fn()
}));

vi.mock("@/lib/nango/cleanup", () => ({
  snapshotNangoConnectionLinks: vi.fn().mockResolvedValue([]),
  revokeNangoConnectionRows: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle", () => ({
  planLifecycleAction: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlanFastPhase: vi.fn(),
  executeLifecyclePlanSlowPhase: vi.fn()
}));

const mockDeleteAuthUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    auth: { admin: { deleteUser: mockDeleteAuthUser } }
  }))
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { DELETE } from "@/app/api/admin/delete-client/route";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { deleteBusiness, getBusiness } from "@/lib/db/businesses";
import {
  revokeNangoConnectionRows,
  snapshotNangoConnectionLinks
} from "@/lib/nango/cleanup";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { logger } from "@/lib/logger";

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
  afterCallbacks.length = 0;
  mockDeleteAuthUser.mockReset();
  mockDeleteAuthUser.mockResolvedValue({ error: null });
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
  vi.mocked(deleteBusiness).mockResolvedValue(undefined);
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
  vi.mocked(executeLifecyclePlanFastPhase).mockResolvedValue({} as never);
  vi.mocked(executeLifecyclePlanSlowPhase).mockResolvedValue(undefined as never);
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
    expect(executeLifecyclePlanFastPhase).toHaveBeenCalledWith(
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
    expect(executeLifecyclePlanFastPhase).not.toHaveBeenCalled();
  });

  it("deletes subscription-less businesses and disables the owner's auth user", async () => {
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { deleted: true }
    });
    expect(deleteBusiness).toHaveBeenCalledWith(BUSINESS_ID);
    // Snapshot BEFORE the row delete (the cascade removes the rows), Nango
    // revocation AFTER it commits (a failed delete leaves the tenant
    // intact, integrations untouched).
    expect(snapshotNangoConnectionLinks).toHaveBeenCalledWith(BUSINESS_ID);
    expect(
      vi.mocked(snapshotNangoConnectionLinks).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(deleteBusiness).mock.invocationCallOrder[0]);
    expect(revokeNangoConnectionRows).toHaveBeenCalledWith(BUSINESS_ID, []);
    expect(
      vi.mocked(revokeNangoConnectionRows).mock.invocationCallOrder[0]
    ).toBeGreaterThan(vi.mocked(deleteBusiness).mock.invocationCallOrder[0]);
    expect(mockDeleteAuthUser).toHaveBeenCalledWith("auth-owner-1");
    expect(planLifecycleAction).not.toHaveBeenCalled();
  });

  it("deletes subscription-less businesses even when the owner has no auth user", async () => {
    vi.mocked(findAuthUserIdByEmail).mockResolvedValueOnce(null);
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(200);
    expect(deleteBusiness).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mockDeleteAuthUser).not.toHaveBeenCalled();
  });

  it("continues subscription-less delete when the auth user is already gone", async () => {
    mockDeleteAuthUser.mockResolvedValueOnce({ error: { message: "User not found" } });
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(200);
    expect(deleteBusiness).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mockDeleteAuthUser).toHaveBeenCalledWith("auth-owner-1");
  });

  it("aborts subscription-less delete when the auth user delete fails (returns 500, preserves business row)", async () => {
    // New contract: auth-delete is the login-disable promise, so a real
    // failure here must abort BEFORE the business-row delete so the
    // operator can retry. Previously the route swallowed the error and
    // soldiered on, leaving an active login attached to a deleted
    // business with no recovery path from this endpoint.
    mockDeleteAuthUser.mockResolvedValueOnce({ error: { message: "Boom" } });
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(500);
    expect(deleteBusiness).not.toHaveBeenCalled();
    expect(mockDeleteAuthUser).toHaveBeenCalledWith("auth-owner-1");
  });

  it("aborts subscription-less delete when deleteUser throws", async () => {
    mockDeleteAuthUser.mockRejectedValueOnce(new Error("network"));
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(500);
    expect(deleteBusiness).not.toHaveBeenCalled();
  });

  it("aborts subscription-less delete when deleteUser throws a non-Error", async () => {
    mockDeleteAuthUser.mockImplementationOnce(() => {
      throw "kaboom";
    });
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(500);
    expect(deleteBusiness).not.toHaveBeenCalled();
  });

  it("aborts subscription-less delete when auth error has no message", async () => {
    // Empty message doesn't match the "not found" regex, so it counts
    // as a real failure under the new contract.
    mockDeleteAuthUser.mockResolvedValueOnce({ error: {} });
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(500);
    expect(deleteBusiness).not.toHaveBeenCalled();
    expect(mockDeleteAuthUser).toHaveBeenCalledWith("auth-owner-1");
  });

  it("skips auth lookup for subscription-less delete when owner email is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      id: BUSINESS_ID,
      owner_email: null
    } as never);
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(200);
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
    expect(mockDeleteAuthUser).not.toHaveBeenCalled();
    expect(deleteBusiness).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("returns 404 when a non-subscription lifecycle context cannot be loaded", async () => {
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: false,
      reason: "business_owner_mismatch"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(404);
    expect(deleteBusiness).not.toHaveBeenCalled();
    expect(planLifecycleAction).not.toHaveBeenCalled();
  });

  it("returns 409 when the planner rejects the action", async () => {
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: false,
      reason: "subscription_already_canceled"
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(409);
    expect(executeLifecyclePlanFastPhase).not.toHaveBeenCalled();
  });

  it("reads vpsHost from ctxRes.vpsHost (top-level), matching every other lifecycle-plan caller", async () => {
    // Regression: this route used to read `ctxRes.context.vpsHost`
    // while `/api/billing/cancel`, `/reactivate`, the Stripe webhook,
    // and the grace-sweep cron all read from `ctxRes.vpsHost`. Both
    // paths happen to resolve to the same value because the loader
    // populates BOTH today, but having two divergent conventions in
    // code paths that all execute lifecycle plans makes future
    // refactors of the loader's return shape error-prone. Pin every
    // executor caller to the top-level convention so a future loader
    // refactor can't silently drop the field on this admin path.
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ok: true,
      vpsHost: "9.9.9.9",
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
        vpsHost: "1.1.1.1"
      }
    } as never);
    const response = await DELETE(makeRequest());
    expect(response.status).toBe(200);
    expect(executeLifecyclePlanFastPhase).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ vpsHost: "9.9.9.9" })
    );
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

  describe("split-phase execution survives Vercel timeout (maxDuration + after)", () => {
    // Regression: this route previously awaited `executeLifecyclePlan`
    // synchronously, which performs Stripe cancel, SSH backup, Hostinger
    // snapshot/stop/billing-cancel, DB updates (auth-user delete +
    // mark_business_wiped), and emails — minutes-long work end-to-end.
    // With no `maxDuration` export the route fell back to the platform
    // default and was torn down mid-teardown on larger tenants. The
    // fix mirrors `/api/billing/cancel` + `/api/admin/force-refund`:
    // split-phase executor + `next/server` `after()` for the slow
    // phase + a 300s ceiling.
    function makeFullPlan() {
      return {
        stripeOps: [
          { type: "cancel_stripe_subscription", stripeSubscriptionId: "sub_stripe" }
        ],
        sshOps: [{ type: "backup_durable_data", vpsHost: "1.2.3.4" }],
        hostingerOps: [
          { type: "create_snapshot", virtualMachineId: 42 },
          { type: "stop_virtual_machine", virtualMachineId: 42 },
          { type: "disable_billing_auto_renewal", virtualMachineId: 42 }
        ],
        dbUpdates: [
          {
            type: "update_subscription",
            subscriptionId: "sub-1",
            patch: { status: "canceled", cancel_reason: "admin_force" }
          },
          { type: "delete_auth_user", supabaseUserId: "auth-owner-1" },
          { type: "mark_business_wiped", businessId: BUSINESS_ID }
        ],
        emailsToSend: []
      };
    }

    it("exports maxDuration = 300 to keep Vercel from tearing down mid-teardown", async () => {
      const mod = await import("@/app/api/admin/delete-client/route");
      expect(mod.maxDuration).toBe(300);
    });

    it("runs the fast phase inline and defers the slow phase via after()", async () => {
      vi.mocked(planLifecycleAction).mockReturnValueOnce({ ok: true, plan: makeFullPlan() } as never);
      vi.mocked(executeLifecyclePlanFastPhase).mockResolvedValueOnce({} as never);

      const response = await DELETE(makeRequest());
      expect(response.status).toBe(200);
      expect(executeLifecyclePlanFastPhase).toHaveBeenCalledTimes(1);
      // Slow phase has NOT yet run when the response is returned —
      // critical so the operator's HTTP call returns in seconds rather
      // than minutes.
      expect(executeLifecyclePlanSlowPhase).not.toHaveBeenCalled();
      expect(afterCallbacks.length).toBe(1);

      await flushAfterCallbacks();
      expect(executeLifecyclePlanSlowPhase).toHaveBeenCalledTimes(1);
      expect(executeLifecyclePlanSlowPhase).toHaveBeenCalledWith(
        expect.objectContaining({
          sshOps: expect.any(Array),
          hostingerOps: expect.any(Array)
        }),
        expect.any(Object)
      );
    });

    it("returns 500 and skips after() when the fast phase throws", async () => {
      vi.mocked(planLifecycleAction).mockReturnValueOnce({ ok: true, plan: makeFullPlan() } as never);
      vi.mocked(executeLifecyclePlanFastPhase).mockRejectedValueOnce(
        new Error("stripe cancel failed")
      );

      const response = await DELETE(makeRequest());
      expect(response.status).toBe(500);
      // No background work scheduled — Stripe cancel never landed.
      expect(afterCallbacks.length).toBe(0);
      expect(executeLifecyclePlanSlowPhase).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "admin.delete-client: fast-phase failed",
        expect.objectContaining({ businessId: BUSINESS_ID })
      );
    });

    it("swallows slow-phase errors so the operator's HTTP call still succeeds", async () => {
      vi.mocked(planLifecycleAction).mockReturnValueOnce({ ok: true, plan: makeFullPlan() } as never);
      vi.mocked(executeLifecyclePlanFastPhase).mockResolvedValueOnce({} as never);
      vi.mocked(executeLifecyclePlanSlowPhase).mockRejectedValueOnce(
        new Error("hostinger api 500")
      );

      const response = await DELETE(makeRequest());
      expect(response.status).toBe(200);
      // Failing slow phase MUST NOT propagate; the response is already
      // sent and the grace-sweep cron is the backstop.
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "admin.delete-client: slow-phase failed (background)",
        expect.objectContaining({ businessId: BUSINESS_ID })
      );
    });
  });
});
