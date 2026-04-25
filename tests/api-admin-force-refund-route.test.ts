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

  it("does not send synthetic profile ids to DB ops when no real profile exists", async () => {
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
    vi.mocked(planLifecycleAction)
      .mockReturnValueOnce({ ok: false, reason: "missing_context" } as never)
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
              type: "update_subscription",
              subscriptionId: "sub-1",
              patch: { customer_profile_id: "admin-synthetic" }
            },
            {
              type: "mark_refund_used",
              profileId: "admin-synthetic",
              at: "2026-04-15T00:00:00.000Z"
            },
            {
              type: "record_refund",
              subscriptionId: "sub-1",
              profileId: "admin-synthetic",
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
    expect(executeLifecyclePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        dbUpdates: [
          expect.objectContaining({
            type: "update_subscription",
            patch: expect.objectContaining({ customer_profile_id: null })
          }),
          expect.objectContaining({
            type: "record_refund",
            profileId: null,
            reason: "admin_force"
          })
        ]
      }),
      expect.anything()
    );
    const plan = vi.mocked(executeLifecyclePlan).mock.calls[0][0];
    expect(plan.dbUpdates.some((op) => op.type === "mark_refund_used")).toBe(false);
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
