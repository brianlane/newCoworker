import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  findAuthUserIdByEmail: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  setBusinessCustomerProfile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  upsertCustomerProfile: vi.fn()
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
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { upsertCustomerProfile } from "@/lib/db/customer-profiles";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";
import { logger } from "@/lib/logger";

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
  vi.mocked(upsertCustomerProfile).mockResolvedValue("prof-upserted");
  vi.mocked(setBusinessCustomerProfile).mockResolvedValue(undefined);
});

describe("api/admin/force-refund route", () => {
  it("runs cancelWithRefund directly and relabels refund audit as admin_force", async () => {
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: true,
      plan: {
        stripeOps: [
          {
            type: "refund_latest_charge",
            stripeSubscriptionId: "sub_stripe",
            reason: "thirty_day_money_back"
          }
        ],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [
          {
            type: "update_subscription",
            subscriptionId: "sub-1",
            patch: {
              status: "canceled",
              cancel_reason: "user_refund",
              customer_profile_id: "prof-old"
            }
          },
          {
            type: "record_refund",
            subscriptionId: "sub-1",
            profileId: "prof-1",
            stripeRefundId: null,
            stripeChargeId: null,
            amountCents: 1000,
            reason: "thirty_day_money_back"
          }
        ],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: BUSINESS_ID,
            reason: "user_refund",
            effectiveAt: "2026-04-15T00:00:00.000Z",
            graceEndsAt: "2026-05-15T00:00:00.000Z"
          }
        ]
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
    expect(executeLifecyclePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [
          {
            type: "refund_latest_charge",
            stripeSubscriptionId: "sub_stripe",
            reason: "admin_force"
          }
        ],
        dbUpdates: [
          expect.objectContaining({
            type: "update_subscription",
            patch: expect.objectContaining({
              cancel_reason: "admin_force",
              customer_profile_id: "prof-1"
            })
          }),
          expect.objectContaining({
            type: "record_refund",
            reason: "admin_force"
          })
        ],
        emailsToSend: [
          expect.objectContaining({
            type: "send_cancel_confirmation",
            reason: "admin_force"
          })
        ]
      }),
      expect.anything()
    );
  });

  it("retries with a synthetic profile when the refund window has closed", async () => {
    vi.mocked(planLifecycleAction)
      .mockReturnValueOnce({ ok: false, reason: "refund_window_closed" } as never)
      .mockReturnValueOnce({
        ok: true,
        plan: {
          stripeOps: [
            {
              type: "refund_latest_charge",
              stripeSubscriptionId: "sub_stripe",
              reason: "thirty_day_money_back"
            }
          ],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [
            {
              type: "record_refund",
              subscriptionId: "sub-1",
              profileId: "prof-1",
              stripeRefundId: null,
              stripeChargeId: null,
              amountCents: 1000,
              reason: "thirty_day_money_back"
            }
          ],
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
    expect(executeLifecyclePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [expect.objectContaining({ reason: "admin_force" })],
        dbUpdates: [expect.objectContaining({ reason: "admin_force" })]
      }),
      expect.anything()
    );
  });

  it("upserts a real customer profile when none exists and stamps mark_refund_used against it", async () => {
    // Previously the route accepted a synthetic profile id and silently
    // filtered out `mark_refund_used`, breaking the lifetime-once policy
    // promise in the module docstring. New behavior: the route MUST
    // upsert a real profile keyed on the owner email BEFORE planning, so
    // `refund_used_at` is stamped on a real row that any future profile
    // merged for the same email would find.
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ...defaultCtx,
      context: {
        ...defaultCtx.context,
        subscription: {
          ...defaultCtx.context.subscription,
          customer_profile_id: null
        },
        profile: null
      }
    } as never);
    vi.mocked(upsertCustomerProfile).mockResolvedValueOnce("prof-upserted");
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: true,
      plan: {
        stripeOps: [
          {
            type: "refund_latest_charge",
            stripeSubscriptionId: "sub_stripe",
            reason: "thirty_day_money_back"
          }
        ],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [
          {
            type: "update_subscription",
            subscriptionId: "sub-1",
            patch: { customer_profile_id: "prof-old" }
          },
          {
            type: "mark_refund_used",
            profileId: "prof-old",
            at: "2026-04-15T00:00:00.000Z"
          },
          {
            type: "record_refund",
            subscriptionId: "sub-1",
            profileId: "prof-old",
            stripeRefundId: null,
            stripeChargeId: null,
            amountCents: 1000,
            reason: "thirty_day_money_back"
          }
        ],
        emailsToSend: []
      }
    } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(upsertCustomerProfile).toHaveBeenCalledWith({
      email: "owner@example.com",
      signupIp: null
    });
    expect(setBusinessCustomerProfile).toHaveBeenCalledWith(BUSINESS_ID, "prof-upserted");
    // Planner ran against the context with the real upserted id threaded in.
    const plannerCtx = (planLifecycleAction as unknown as { mock: { calls: [unknown, { subscription: { customer_profile_id: string } }][] } })
      .mock.calls[0][1];
    expect(plannerCtx.subscription.customer_profile_id).toBe("prof-upserted");
    // Executor receives the rewritten plan with mark_refund_used retained
    // and pointing at the real profile id.
    const plan = vi.mocked(executeLifecyclePlan).mock.calls[0][0];
    expect(plan.dbUpdates.some((op) => op.type === "mark_refund_used")).toBe(true);
    const markOp = plan.dbUpdates.find((op) => op.type === "mark_refund_used") as
      | { type: "mark_refund_used"; profileId: string }
      | undefined;
    expect(markOp?.profileId).toBe("prof-upserted");
    const updateOp = plan.dbUpdates.find((op) => op.type === "update_subscription") as
      | { type: "update_subscription"; patch: { customer_profile_id: string } }
      | undefined;
    expect(updateOp?.patch.customer_profile_id).toBe("prof-upserted");
  });

  it("returns 409 when no real profile exists and the business has no owner_email", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      id: BUSINESS_ID,
      owner_email: null,
      status: "online",
      tier: "standard",
      hostinger_vps_id: "42"
    } as never);
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ...defaultCtx,
      context: {
        ...defaultCtx.context,
        subscription: {
          ...defaultCtx.context.subscription,
          customer_profile_id: null
        },
        profile: null
      }
    } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "cannot_enforce_refund_policy_without_profile"
      })
    });
    expect(upsertCustomerProfile).not.toHaveBeenCalled();
    expect(planLifecycleAction).not.toHaveBeenCalled();
    expect(executeLifecyclePlan).not.toHaveBeenCalled();
  });

  it("returns 500 when the customer profile upsert fails", async () => {
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ...defaultCtx,
      context: {
        ...defaultCtx.context,
        subscription: {
          ...defaultCtx.context.subscription,
          customer_profile_id: null
        },
        profile: null
      }
    } as never);
    vi.mocked(upsertCustomerProfile).mockRejectedValueOnce(new Error("db exploded"));

    const response = await POST(makeRequest());
    expect(response.status).toBe(500);
    expect(planLifecycleAction).not.toHaveBeenCalled();
  });

  it("continues when setBusinessCustomerProfile fails after a successful upsert (best-effort attach)", async () => {
    vi.mocked(loadLifecycleContextForBusiness).mockResolvedValueOnce({
      ...defaultCtx,
      context: {
        ...defaultCtx.context,
        subscription: {
          ...defaultCtx.context.subscription,
          customer_profile_id: null
        },
        profile: null
      }
    } as never);
    vi.mocked(upsertCustomerProfile).mockResolvedValueOnce("prof-upserted");
    vi.mocked(setBusinessCustomerProfile).mockRejectedValueOnce(new Error("attach failed"));
    vi.mocked(planLifecycleAction).mockReturnValueOnce({
      ok: true,
      plan: { stripeOps: [], hostingerOps: [], sshOps: [], dbUpdates: [], emailsToSend: [] }
    } as never);

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "admin.force-refund: setBusinessCustomerProfile failed (continuing)",
      expect.objectContaining({ businessId: BUSINESS_ID })
    );
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
