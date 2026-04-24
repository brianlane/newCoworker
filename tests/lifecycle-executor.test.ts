import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLifecyclePlan, type ExecutorDeps } from "@/lib/billing/lifecycle-executor";
import type { LifecyclePlan } from "@/lib/billing/lifecycle";

const {
  updateSubscriptionMock,
  markRefundUsedMock,
  recordSubscriptionRefundMock,
  sendOwnerEmailMock
} = vi.hoisted(() => ({
  updateSubscriptionMock: vi.fn(),
  markRefundUsedMock: vi.fn(),
  recordSubscriptionRefundMock: vi.fn(),
  sendOwnerEmailMock: vi.fn()
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
  updateBusinessStatus: vi.fn()
}));

vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: vi.fn(),
  deleteBusinessBackup: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
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
});
