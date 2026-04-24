import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLifecyclePlan, type ExecutorDeps } from "@/lib/billing/lifecycle-executor";
import type { LifecyclePlan } from "@/lib/billing/lifecycle";
import { HostingerApiError } from "@/lib/hostinger/client";

const {
  updateSubscriptionMock,
  markRefundUsedMock,
  recordSubscriptionRefundMock,
  sendOwnerEmailMock,
  updateBusinessStatusMock,
  backupBusinessDataMock,
  deleteBusinessBackupMock,
  createSupabaseServiceClientMock
} = vi.hoisted(() => ({
  updateSubscriptionMock: vi.fn(),
  markRefundUsedMock: vi.fn(),
  recordSubscriptionRefundMock: vi.fn(),
  sendOwnerEmailMock: vi.fn(),
  updateBusinessStatusMock: vi.fn(),
  backupBusinessDataMock: vi.fn(),
  deleteBusinessBackupMock: vi.fn(),
  createSupabaseServiceClientMock: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  updateSubscription: updateSubscriptionMock
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  markRefundUsed: markRefundUsedMock
}));

vi.mock("@/lib/db/subscription-refunds", () => ({
  recordSubscriptionRefund: recordSubscriptionRefundMock
}));

vi.mock("@/lib/db/businesses", () => ({
  updateBusinessStatus: updateBusinessStatusMock
}));

vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: backupBusinessDataMock,
  deleteBusinessBackup: deleteBusinessBackupMock
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: createSupabaseServiceClientMock
}));

vi.mock("@/lib/stripe/client", () => ({
  getStripe: vi.fn()
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: sendOwnerEmailMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

function refundPlan(amountCents = 2500): LifecyclePlan {
  return {
    stripeOps: [
      {
        type: "refund_latest_charge",
        stripeSubscriptionId: "sub_123",
        reason: "thirty_day_money_back"
      }
    ],
    hostingerOps: [],
    sshOps: [],
    dbUpdates: [
      { type: "mark_refund_used", profileId: "prof_1", at: "2026-04-15T00:00:00.000Z" },
      {
        type: "record_refund",
        subscriptionId: "sub_row_1",
        profileId: "prof_1",
        stripeRefundId: null,
        stripeChargeId: null,
        amountCents,
        reason: "thirty_day_money_back"
      }
    ],
    emailsToSend: [
      {
        type: "send_refund_issued",
        toEmail: "owner@example.com",
        businessId: "biz_1",
        amountCents
      }
    ]
  };
}

describe("executeLifecyclePlan refund handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    backupBusinessDataMock.mockResolvedValue({});
    deleteBusinessBackupMock.mockResolvedValue(undefined);
    updateBusinessStatusMock.mockResolvedValue(undefined);
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } }
    });
  });

  it("refunds invoices whose charge is only reachable through payment_intent.latest_charge", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_123" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_123",
          amount_paid: 2500,
          payments: {
            data: [{ payment: { payment_intent: "pi_123" } }]
          }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_123", latest_charge: "ch_123" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_123" }) }
    };

    await executeLifecyclePlan(
      refundPlan(),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_123", amount: 2500 })
    );
    expect(markRefundUsedMock).toHaveBeenCalledWith("prof_1", expect.any(Date));
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeRefundId: "re_123",
        stripeChargeId: "ch_123",
        amountCents: 2500
      })
    );
    expect(updateSubscriptionMock).toHaveBeenCalledWith("sub_row_1", {
      stripe_refund_id: "re_123",
      refund_amount_cents: 2500
    });
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringMatching(/refund/i),
      expect.stringContaining("$25.00")
    );
  });

  it("does not burn refund eligibility or send refund email when Stripe has no paid amount", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_zero" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_zero",
          amount_paid: 0,
          payments: {
            data: [{ payment: { payment_intent: "pi_zero" } }]
          }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_zero", latest_charge: "ch_zero" })
      },
      refunds: { create: vi.fn() }
    };

    await executeLifecyclePlan(
      refundPlan(0),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(markRefundUsedMock).not.toHaveBeenCalled();
    expect(recordSubscriptionRefundMock).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("executes non-refund Stripe, SSH, Hostinger, DB, and cancel email ops", async () => {
    const stripe = {
      subscriptions: {
        update: vi.fn().mockResolvedValue({}),
        retrieve: vi
          .fn()
          .mockResolvedValueOnce({ status: "active", schedule: { id: "sched_obj" } })
          .mockResolvedValueOnce({ status: "canceled", schedule: null })
          .mockRejectedValueOnce(new Error("missing")),
        cancel: vi.fn().mockResolvedValue({})
      },
      subscriptionSchedules: {
        release: vi.fn().mockRejectedValueOnce(new Error("release failed"))
      }
    };
    const notFound = new HostingerApiError("/snapshot", 404, {}, "gone");
    const hostinger = {
      createSnapshot: vi.fn().mockResolvedValue({}),
      deleteSnapshot: vi.fn().mockRejectedValue(notFound),
      stopVirtualMachine: vi.fn().mockResolvedValue({}),
      cancelBillingSubscription: vi.fn().mockResolvedValue({})
    };

    await executeLifecyclePlan(
      {
        stripeOps: [
          { type: "set_cancel_at_period_end", stripeSubscriptionId: "sub_1", cancelAtPeriodEnd: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_1", releaseSchedule: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_2", releaseSchedule: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_missing", releaseSchedule: true }
        ],
        sshOps: [
          { type: "backup_durable_data", businessId: "biz_1", vpsHost: "1.2.3.4" },
          { type: "restore_durable_data", businessId: "biz_1", vpsHost: "1.2.3.5" }
        ],
        hostingerOps: [
          { type: "create_snapshot", virtualMachineId: 1 },
          { type: "delete_snapshot", virtualMachineId: 1 },
          { type: "stop_vm", virtualMachineId: 1 },
          { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs_1" }
        ],
        dbUpdates: [
          { type: "update_subscription", subscriptionId: "sub_row", patch: { status: "canceled" } },
          { type: "mark_business_wiped", businessId: "biz_1" },
          { type: "delete_auth_user", supabaseUserId: "user_1" },
          { type: "delete_backup_artifact", businessId: "biz_1" }
        ],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: "biz_1",
            reason: "user_period_end",
            effectiveAt: "2026-05-01T00:00:00.000Z",
            graceEndsAt: null
          }
        ]
      },
      { businessId: "biz_1", vpsHost: "1.2.3.4" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], hostinger: hostinger as never, sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      cancel_at_period_end: true,
      proration_behavior: "none"
    });
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sched_obj");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", {
      prorate: false,
      invoice_now: false
    });
    expect(backupBusinessDataMock).toHaveBeenCalledWith({ businessId: "biz_1", vpsHost: "1.2.3.4" });
    expect(hostinger.createSnapshot).toHaveBeenCalledWith(1);
    expect(hostinger.stopVirtualMachine).toHaveBeenCalledWith(1);
    expect(hostinger.cancelBillingSubscription).toHaveBeenCalledWith("hbs_1");
    expect(updateBusinessStatusMock).toHaveBeenCalledWith("biz_1", "wiped");
    expect(deleteBusinessBackupMock).toHaveBeenCalledWith("biz_1");
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringMatching(/scheduled/i),
      expect.stringContaining("Your cancellation is scheduled")
    );
  });

  it("covers alternate refund charge shapes and error paths", async () => {
    const chargeObjectStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: { id: "in_charge_obj" } }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          amount_due: 1500,
          charge: { id: "ch_obj" },
          payments: { data: [] }
        })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_obj" }) }
    };
    await executeLifecyclePlan(
      refundPlan(1500),
      { businessId: "biz_1", vpsHost: null },
      { stripe: chargeObjectStripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );
    expect(chargeObjectStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ charge: "ch_obj" }));

    const expandedPiStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_pi_obj" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          amount_paid: 1200,
          payments: { data: [{ payment: { payment_intent: { latest_charge: { id: "ch_expanded" } } } }] }
        })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_expanded" }) }
    };
    await executeLifecyclePlan(
      refundPlan(1200),
      { businessId: "biz_1", vpsHost: null },
      { stripe: expandedPiStripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );
    expect(expandedPiStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ charge: "ch_expanded" }));

    const chargesArrayStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_charges" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          amount_paid: 1300,
          payments: { data: [{ payment: { payment_intent: { charges: { data: [{ id: "ch_array" }] } } } }] }
        })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_array" }) }
    };
    await executeLifecyclePlan(
      refundPlan(1300),
      { businessId: "biz_1", vpsHost: null },
      { stripe: chargesArrayStripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );
    expect(chargesArrayStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ charge: "ch_array" }));

    const noInvoiceStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: null }) }
    };
    await expect(
      executeLifecyclePlan(refundPlan(), { businessId: "biz_1", vpsHost: null }, { stripe: noInvoiceStripe as never })
    ).rejects.toThrow("no latest_invoice");

    const noChargeStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_no_charge" }) },
      invoices: { retrieve: vi.fn().mockResolvedValue({ amount_paid: 1000, payments: { data: [] } }) }
    };
    await expect(
      executeLifecyclePlan(refundPlan(), { businessId: "biz_1", vpsHost: null }, { stripe: noChargeStripe as never })
    ).rejects.toThrow("no charge on invoice");
  });

  it("handles auth-delete and email failure branches", async () => {
    createSupabaseServiceClientMock.mockResolvedValueOnce({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: { message: "user not found" } }) } }
    });
    await executeLifecyclePlan(
      {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [{ type: "delete_auth_user", supabaseUserId: "missing-user" }],
        emailsToSend: []
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never }
    );

    createSupabaseServiceClientMock.mockResolvedValueOnce({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: { message: "hard fail" } }) } }
    });
    await expect(
      executeLifecyclePlan(
        {
          stripeOps: [],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [{ type: "delete_auth_user", supabaseUserId: "bad-user" }],
          emailsToSend: []
        },
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never }
      )
    ).rejects.toThrow("delete_auth_user: hard fail");

    delete process.env.RESEND_API_KEY;
    await executeLifecyclePlan(
      {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: "biz_1",
            reason: "user_refund",
            effectiveAt: "2026-04-01T00:00:00.000Z",
            graceEndsAt: "2026-05-01T00:00:00.000Z"
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: vi.fn().mockRejectedValue(new Error("smtp down")) }
    );

    process.env.RESEND_API_KEY = "resend_test";
    await executeLifecyclePlan(
      {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: "biz_1",
            reason: "user_refund",
            effectiveAt: "2026-04-01T00:00:00.000Z",
            graceEndsAt: "2026-05-01T00:00:00.000Z"
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: vi.fn().mockRejectedValue(new Error("smtp down")) }
    );
  });

  it("surfaces non-tolerated Hostinger failures and tolerates backup deletion failures", async () => {
    const hostinger = {
      createSnapshot: vi.fn().mockRejectedValue(new Error("hostinger hard fail"))
    };
    await expect(
      executeLifecyclePlan(
        {
          stripeOps: [],
          hostingerOps: [{ type: "create_snapshot", virtualMachineId: 1 }],
          sshOps: [],
          dbUpdates: [],
          emailsToSend: []
        },
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never, hostinger: hostinger as never }
      )
    ).rejects.toThrow("hostinger hard fail");

    deleteBusinessBackupMock.mockRejectedValueOnce(new Error("delete failed"));
    await executeLifecyclePlan(
      {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [{ type: "delete_backup_artifact", businessId: "biz_1" }],
        emailsToSend: []
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never }
    );
  });
});
