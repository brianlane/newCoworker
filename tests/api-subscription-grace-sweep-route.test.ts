/**
 * Tests the /api/internal/subscription-grace-sweep endpoint — the wipe step
 * for canceled subscriptions past their grace deadline. Exercises:
 *   - bearer auth (no secret → 403)
 *   - single-row happy path (planner + executor are invoked)
 *   - per-row failure isolation (one throwing row doesn't abort the sweep)
 *   - skipped rows (missing business, context load failure, planner rejection)
 *
 * The lifecycle planner/executor/loader are all stubbed so the test stays
 * focused on the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  listGraceExpiredSubscriptions: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  findAuthUserIdByEmail: vi.fn()
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

import { POST } from "@/app/api/internal/subscription-grace-sweep/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { listGraceExpiredSubscriptions } from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/subscription-grace-sweep", {
    method: "POST",
    headers: {
      Authorization: "Bearer secret",
      "Content-Type": "application/json"
    },
    body: "{}"
  });
}

function makeSubRow(over: Record<string, unknown> = {}): unknown {
  return {
    id: "sub-1",
    business_id: "biz-1",
    status: "canceled",
    grace_ends_at: "2026-01-01T00:00:00.000Z",
    wiped_at: null,
    customer_profile_id: "cp-1",
    ...over
  };
}

describe("api/internal/subscription-grace-sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("rejects requests without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(vi.mocked(listGraceExpiredSubscriptions)).not.toHaveBeenCalled();
  });

  it("wipes each grace-expired row through the planner + executor", async () => {
    vi.mocked(listGraceExpiredSubscriptions).mockResolvedValue([
      makeSubRow({ id: "sub-1", business_id: "biz-1" }),
      makeSubRow({ id: "sub-2", business_id: "biz-2" })
    ] as never);
    vi.mocked(getBusiness).mockImplementation(async (id: string) =>
      ({ id, owner_email: `${id}@example.com` }) as never
    );
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("user-1");
    vi.mocked(loadLifecycleContextForBusiness).mockImplementation(async (businessId: string) =>
      ({
        ok: true,
        context: {
          subscription: { id: `sub-${businessId}`, customer_profile_id: "cp-1" }
        },
        vpsHost: "1.2.3.4"
      }) as never
    );
    vi.mocked(planLifecycleAction).mockReturnValue({
      ok: true,
      plan: { stripeOps: [], hostingerOps: [], sshOps: [], dbUpdates: [], emailsToSend: [] }
    } as never);
    vi.mocked(executeLifecyclePlan).mockResolvedValue(undefined as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      processed: 2,
      wiped: 2,
      skipped: 0,
      errors: []
    });
    expect(vi.mocked(executeLifecyclePlan)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(planLifecycleAction)).toHaveBeenCalledWith(
      { type: "graceExpiredWipe" },
      expect.any(Object)
    );
  });

  it("skips rows whose business is missing or planner rejects them", async () => {
    vi.mocked(listGraceExpiredSubscriptions).mockResolvedValue([
      makeSubRow({ id: "sub-missing-biz", business_id: "biz-missing" }),
      makeSubRow({ id: "sub-ctx-fail", business_id: "biz-ctx-fail" }),
      makeSubRow({ id: "sub-planner-rejects", business_id: "biz-planner-rejects" })
    ] as never);
    vi.mocked(getBusiness).mockImplementation(async (id: string) => {
      if (id === "biz-missing") return null;
      return { id, owner_email: `${id}@example.com` } as never;
    });
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    vi.mocked(loadLifecycleContextForBusiness).mockImplementation(async (businessId: string) => {
      if (businessId === "biz-ctx-fail") {
        return { ok: false, reason: "subscription_not_found" } as never;
      }
      return {
        ok: true,
        context: { subscription: { customer_profile_id: null } },
        vpsHost: null
      } as never;
    });
    vi.mocked(planLifecycleAction).mockReturnValue({
      ok: false,
      reason: "subscription_not_in_grace"
    } as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ processed: 3, wiped: 0, skipped: 3, errors: [] });
    expect(vi.mocked(executeLifecyclePlan)).not.toHaveBeenCalled();
  });

  it("processes every eligible row per cron tick (no 50-row batch cap)", async () => {
    // Regression: the prior `DEFAULT_BATCH_LIMIT = 50` cap meant a >50-row
    // backlog drained at one batch per cron fire, so the 51st-and-up
    // tail kept burning Hostinger billing until the next tick. We now
    // request every eligible row per invocation; the helper still gets
    // a finite limit (Number.MAX_SAFE_INTEGER) to satisfy its required
    // arg, but the route must not pass the old 50-row default.
    vi.mocked(listGraceExpiredSubscriptions).mockResolvedValue([] as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(vi.mocked(listGraceExpiredSubscriptions)).toHaveBeenCalledTimes(1);
    const passedLimit = vi.mocked(listGraceExpiredSubscriptions).mock.calls[0][1];
    expect(passedLimit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("exports maxDuration so Vercel keeps the function alive long enough to drain the backlog", async () => {
    // Mirrors the `/api/billing/cancel` + `/api/admin/delete-client` +
    // `/api/admin/force-refund` pattern. Without this, the platform
    // default (10s on Hobby, ~15s on most Pro configs) would tear the
    // function down mid-sweep and leave Stripe-canceled-but-VPS-alive
    // tenants until the next cron tick — exactly what the sweep is
    // supposed to backstop.
    const routeModule = await import("@/app/api/internal/subscription-grace-sweep/route");
    expect(routeModule.maxDuration).toBe(300);
  });

  it("captures per-row failures without aborting the run", async () => {
    vi.mocked(listGraceExpiredSubscriptions).mockResolvedValue([
      makeSubRow({ id: "sub-ok", business_id: "biz-ok" }),
      makeSubRow({ id: "sub-boom", business_id: "biz-boom" })
    ] as never);
    vi.mocked(getBusiness).mockImplementation(async (id: string) =>
      ({ id, owner_email: `${id}@example.com` }) as never
    );
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("user-1");
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValue({
      ok: true,
      context: { subscription: { customer_profile_id: "cp-1" } },
      vpsHost: "1.2.3.4"
    } as never);
    vi.mocked(planLifecycleAction).mockReturnValue({
      ok: true,
      plan: { stripeOps: [], hostingerOps: [], sshOps: [], dbUpdates: [], emailsToSend: [] }
    } as never);
    vi.mocked(executeLifecyclePlan).mockImplementation(async (_plan, extra) => {
      if (extra.businessId === "biz-boom") {
        throw new Error("hostinger 500");
      }
      return undefined as never;
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ processed: 2, wiped: 1, skipped: 0 });
    expect((body.data as { errors: unknown[] }).errors).toHaveLength(1);
  });
});
