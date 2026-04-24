import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn().mockResolvedValue({
    current_period_start: 1700000000,
    current_period_end: 1702678400
  })
}));

const { mockCheckoutSessionsList } = vi.hoisted(() => ({
  mockCheckoutSessionsList: vi.fn()
}));

const { mockLoadLifecycleContext, mockExecuteLifecyclePlan } = vi.hoisted(() => ({
  mockLoadLifecycleContext: vi.fn(),
  mockExecuteLifecyclePlan: vi.fn()
}));

vi.mock("@/lib/stripe/client", () => ({
  ensureCommitmentSchedule: vi.fn(),
  verifyWebhook: vi.fn(),
  getStripe: vi.fn(() => ({
    subscriptions: { retrieve: mockStripeRetrieve },
    checkout: { sessions: { list: mockCheckoutSessionsList } }
  }))
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    getSubscription: vi.fn(),
    getSubscriptionByStripeSubscriptionId: vi.fn(),
    updateSubscription: vi.fn()
  };
});

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

const mockVoiceBonusRpc = vi.hoisted(() =>
  vi.fn().mockImplementation((name: string) => {
    if (name === "apply_voice_bonus_grant_from_checkout") {
      return Promise.resolve({ data: { ok: true, duplicate: false }, error: null });
    }
    if (name === "voice_sync_low_balance_alert_armed") {
      return Promise.resolve({ data: 0, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  })
);

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({
    rpc: mockVoiceBonusRpc
  })
}));

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: mockLoadLifecycleContext
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: mockExecuteLifecyclePlan
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}));

import {
  POST,
  computeVoiceBonusClawbackSeconds,
  parseVoiceBonusSecondsFromMetadata
} from "@/app/api/webhooks/stripe/route";
import { ensureCommitmentSchedule, verifyWebhook } from "@/lib/stripe/client";
import {
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  updateSubscription
} from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { logger } from "@/lib/logger";

describe("stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceBonusRpc.mockClear();
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "apply_voice_bonus_grant_from_checkout") {
        return Promise.resolve({ data: { ok: true, duplicate: false }, error: null });
      }
      if (name === "voice_sync_low_balance_alert_armed") {
        return Promise.resolve({ data: 0, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStripeRetrieve.mockClear();
    mockStripeRetrieve.mockResolvedValue({
      current_period_start: 1700000000,
      current_period_end: 1702678400
    });
    mockLoadLifecycleContext.mockReset();
    mockExecuteLifecyclePlan.mockReset();
    mockExecuteLifecyclePlan.mockResolvedValue({});
    vi.mocked(getBusiness).mockResolvedValue({ status: "pending" } as never);
    vi.mocked(ensureCommitmentSchedule).mockResolvedValue("sub_sched_123");
  });

  it("activates and provisions on checkout.session.completed", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: {
            businessId: "biz_1",
            tier: "starter",
            billingPeriod: "annual"
          },
          customer: "cus_1",
          subscription: "sub_1"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_1",
      status: "pending",
      stripe_subscription_id: null
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_1",
      expect.objectContaining({
        status: "active",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        stripe_current_period_start: expect.any(String),
        stripe_current_period_end: expect.any(String),
        stripe_subscription_cached_at: expect.any(String)
      })
    );
    expect(ensureCommitmentSchedule).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      tier: "starter",
      billingPeriod: "annual"
    });
    expect(orchestrateProvisioning).toHaveBeenCalledWith({ businessId: "biz_1", tier: "starter" });
  });

  it("records voice bonus grant on payment checkout with voice_bonus_seconds metadata", async () => {
    const bid = "00000000-0000-4000-8000-000000000001";
    const periodEndSec = 1702678400;
    const createdSec = 1700000000;
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_bonus",
      business_id: bid,
      status: "active",
      stripe_subscription_id: "sub_bonus_1"
    } as never);
    mockStripeRetrieve.mockResolvedValue({
      status: "active",
      current_period_start: 1700000000,
      current_period_end: periodEndSec
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_bonus",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_voice_bonus",
          mode: "payment",
          created: createdSec,
          metadata: {
            checkoutKind: "voice_bonus_seconds",
            businessId: bid,
            voiceSeconds: "600"
          }
        }
      }
    } as never);

    const plus30Ms = createdSec * 1000 + 30 * 24 * 60 * 60 * 1000;
    const expectedExpires =
      periodEndSec * 1000 >= plus30Ms
        ? new Date(periodEndSec * 1000).toISOString()
        : new Date(plus30Ms).toISOString();

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "apply_voice_bonus_grant_from_checkout",
      expect.objectContaining({
        p_business_id: bid,
        p_checkout_session_id: "cs_test_voice_bonus",
        p_seconds_purchased: 600,
        p_expires_at: expectedExpires
      })
    );
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "voice_sync_low_balance_alert_armed_for_business",
      expect.objectContaining({ p_business_id: bid, p_threshold_seconds: 300 })
    );
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("does not record voice bonus grant without an active subscription row", async () => {
    const bid = "00000000-0000-4000-8000-000000000002";
    vi.mocked(getSubscription).mockResolvedValue(null);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_bonus_block",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_voice_bonus_block",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "voice_bonus_seconds",
            businessId: bid,
            voiceSeconds: "120"
          }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(mockVoiceBonusRpc).not.toHaveBeenCalled();
  });

  it("leaves pending subscription untouched on async payment failure (no past_due)", async () => {
    // Lifecycle policy (plan §blocker B2): `past_due` is never written by
    // app code. Pending subs (never activated) are simply left for the
    // abandoned-subs cleanup job to prune; active subs are routed through
    // the `autoCancelOnPaymentFailure` lifecycle action on
    // `invoice.payment_failed`, not here.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_2",
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: "cs_test_failed",
          metadata: {
            businessId: "biz_2"
          }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("does not clobber a canceled lifecycle row when Stripe keeps sending dunning statuses", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_canceled",
      status: "canceled",
      business_id: "biz_canceled"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_dunning_tail",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_dunning",
          status: "past_due",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_canceled" }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).not.toHaveBeenCalledWith(
      "local_sub_canceled",
      expect.objectContaining({ status: "pending" })
    );
  });

  it("runs lifecycle teardown when a period-end subscription is deleted by Stripe", async () => {
    const existing = {
      id: "local_sub_period_end",
      business_id: "biz_period_end",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_period_end",
      tier: "starter",
      status: "active",
      billing_period: "monthly",
      renewal_at: null,
      commitment_months: 1,
      stripe_current_period_start: "2026-04-01T00:00:00.000Z",
      stripe_current_period_end: "2026-05-01T00:00:00.000Z",
      stripe_subscription_cached_at: "2026-04-01T00:00:00.000Z",
      customer_profile_id: "prof-1",
      canceled_at: "2026-04-15T00:00:00.000Z",
      cancel_reason: "user_period_end",
      grace_ends_at: null,
      wiped_at: null,
      vps_stopped_at: null,
      hostinger_billing_subscription_id: "hbs-1",
      cancel_at_period_end: true,
      stripe_refund_id: null,
      refund_amount_cents: null,
      created_at: "2026-04-01T00:00:00.000Z"
    };
    vi.mocked(getSubscription).mockResolvedValue(existing as never);
    mockLoadLifecycleContext.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: {
        subscription: existing,
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "user-1",
        profile: null,
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        now: new Date("2026-05-01T00:00:00.000Z")
      }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_period_end_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_period_end",
          metadata: { businessId: "biz_period_end" }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(mockExecuteLifecyclePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [],
        hostingerOps: expect.arrayContaining([
          { type: "cancel_billing_subscription", hostingerBillingSubscriptionId: "hbs-1" }
        ])
      }),
      expect.objectContaining({ businessId: "biz_period_end", vpsHost: "1.2.3.4" })
    );
  });

  it("does not rerun period-end teardown when a deleted webhook is replayed after teardown", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_period_end",
      business_id: "biz_period_end",
      status: "canceled",
      cancel_reason: "user_period_end",
      cancel_at_period_end: false,
      grace_ends_at: "2026-06-01T00:00:00.000Z",
      canceled_at: "2026-05-01T00:00:00.000Z"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_period_end_deleted_replay",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_period_end",
          metadata: { businessId: "biz_period_end" }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(mockLoadLifecycleContext).not.toHaveBeenCalled();
    expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_period_end",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: "user_period_end",
        cancel_at_period_end: false
      })
    );
  });

  it("preserves null cancel reason for external Stripe cancellations", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_external",
      business_id: "biz_external",
      status: "active",
      cancel_reason: null,
      cancel_at_period_end: false,
      grace_ends_at: null,
      canceled_at: null
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_external_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_external",
          metadata: { businessId: "biz_external" }
        }
      }
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(mockLoadLifecycleContext).not.toHaveBeenCalled();
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_external",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: null,
        cancel_at_period_end: false
      })
    );
  });

  it("marks subscription active on invoice.paid", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_3",
      type: "invoice.paid",
      data: {
        object: {
          parent: {
            subscription_details: {
              subscription: "sub_3"
            }
          }
        }
      }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_3"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_3",
      expect.objectContaining({
        status: "active",
        stripe_current_period_start: expect.any(String),
        stripe_current_period_end: expect.any(String),
        stripe_subscription_cached_at: expect.any(String)
      })
    );
  });

  it("still provisions when commitment schedule setup fails", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_4",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: {
            businessId: "biz_4",
            tier: "standard",
            billingPeriod: "biennial"
          },
          customer: "cus_4",
          subscription: "sub_4"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_4",
      status: "pending",
      stripe_subscription_id: null
    } as never);
    vi.mocked(ensureCommitmentSchedule).mockRejectedValueOnce(new Error("schedule api unavailable"));

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_4",
      expect.objectContaining({
        status: "active",
        stripe_customer_id: "cus_4",
        stripe_subscription_id: "sub_4",
        stripe_current_period_start: expect.any(String)
      })
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Stripe commitment schedule setup failed",
      expect.objectContaining({
        businessId: "biz_4",
        subscriptionId: "sub_4",
        billingPeriod: "biennial",
        error: "schedule api unavailable"
      })
    );
    expect(orchestrateProvisioning).toHaveBeenCalledWith({ businessId: "biz_4", tier: "standard" });
  });
});

describe("stripe webhook route: voice bonus refund / dispute handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceBonusRpc.mockClear();
    mockCheckoutSessionsList.mockReset();
    mockCheckoutSessionsList.mockResolvedValue({
      data: [
        {
          id: "cs_test_bonus_for_refund",
          metadata: { checkoutKind: "voice_bonus_seconds", businessId: "biz_ref_1" }
        }
      ]
    } as never);
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "void_voice_bonus_grant_by_checkout_session") {
        return Promise.resolve({ data: { ok: true, voided: 1 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  async function postEvent() {
    return POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
  }

  it("does NOT void on dispute.created (observational only; dispute outcome unknown)", async () => {
    // A dispute opened is not a terminal outcome. Stripe disputes can close as
    // `lost` / `won` / `warning_closed`; only `lost` reverses funds. Voiding at
    // open would permanently revoke seconds from customers whose merchants
    // successfully defend — the handler has no re-grant compensation path.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_dispute_created",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_created_1",
          payment_intent: "pi_created_1",
          charge: "ch_created_1",
          reason: "fraudulent",
          amount: 3000
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    // Must not even look up the Checkout Session.
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
    // But we should log the open for ops visibility.
    expect(logger.info).toHaveBeenCalledWith(
      "Stripe dispute created; deferring clawback to dispute.closed/lost",
      expect.objectContaining({
        disputeId: "dp_created_1",
        chargeId: "ch_created_1",
        reason: "fraudulent",
        amount: 3000
      })
    );
  });

  it("does NOT void when dispute closed with status=won (merchant defended successfully)", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_dispute_won",
      type: "charge.dispute.closed",
      data: {
        object: {
          id: "dp_won_1",
          status: "won",
          payment_intent: "pi_won_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Stripe dispute closed without chargeback; not voiding bonus grant",
      expect.objectContaining({ disputeId: "dp_won_1", status: "won" })
    );
  });

  it("does NOT void when dispute closed with status=warning_closed (no chargeback)", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_dispute_warn_closed",
      type: "charge.dispute.closed",
      data: {
        object: {
          id: "dp_warn_1",
          status: "warning_closed",
          payment_intent: "pi_warn_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
  });

  it("DOES void when dispute closed with status=lost (funds clawed back)", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_dispute_lost",
      type: "charge.dispute.closed",
      data: {
        object: {
          id: "dp_lost_1",
          status: "lost",
          payment_intent: "pi_lost_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).toHaveBeenCalledWith({
      payment_intent: "pi_lost_1",
      limit: 5
    });
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      {
        p_checkout_session_id: "cs_test_bonus_for_refund",
        p_reason: "dispute",
        p_clawback_seconds: null
      }
    );
  });

  it("DOES void on charge.refunded with positive amount_refunded", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_1",
          amount_refunded: 500,
          payment_intent: "pi_refund_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      {
        p_checkout_session_id: "cs_test_bonus_for_refund",
        p_reason: "refund",
        p_clawback_seconds: null
      }
    );
  });

  it("does NOT void on charge.refunded with zero amount_refunded (defensive)", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_refund_zero",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_zero",
          amount_refunded: 0,
          payment_intent: "pi_refund_zero"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
  });

  it("ignores refund events without a payment_intent", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_no_pi",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_no_pi",
          amount_refunded: 100,
          payment_intent: null
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
  });

  it("ignores refund events whose Checkout Session is not a voice_bonus_seconds purchase", async () => {
    mockCheckoutSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_subscription_not_bonus",
          metadata: { checkoutKind: "subscription", businessId: "biz_sub" }
        }
      ]
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_refund_sub",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_sub",
          amount_refunded: 9900,
          payment_intent: "pi_sub_refund"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionsList).toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
  });

  it("logs and continues when the void RPC errors for one session", async () => {
    mockCheckoutSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_err",
          metadata: { checkoutKind: "voice_bonus_seconds", businessId: "biz_err" }
        },
        {
          id: "cs_ok",
          metadata: { checkoutKind: "voice_bonus_seconds", businessId: "biz_ok" }
        }
      ]
    } as never);
    mockVoiceBonusRpc.mockImplementation((_name: string, args: { p_checkout_session_id?: string }) => {
      if (args?.p_checkout_session_id === "cs_err") {
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }
      return Promise.resolve({ data: { ok: true, voided: 1 }, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_partial_err",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_err",
          amount_refunded: 100,
          payment_intent: "pi_err"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session failed",
      expect.objectContaining({ sessionId: "cs_err", error: "boom" })
    );
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      {
        p_checkout_session_id: "cs_ok",
        p_reason: "refund",
        p_clawback_seconds: null
      }
    );
  });

  it("logs and returns 200 when the Checkout Sessions list call throws", async () => {
    mockCheckoutSessionsList.mockRejectedValueOnce(new Error("rate limited"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_list_throw",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_list_throw",
          amount_refunded: 200,
          payment_intent: "pi_list_throw"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      "Stripe checkout sessions list failed during refund handling",
      expect.objectContaining({ paymentIntentId: "pi_list_throw", error: "rate limited" })
    );
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
  });

  it("prorates clawback seconds on a partial refund when charge amount and seconds metadata are present", async () => {
    mockCheckoutSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_partial",
          amount_total: 2000,
          metadata: {
            checkoutKind: "voice_bonus_seconds",
            businessId: "biz_partial",
            voiceSeconds: "1200"
          }
        }
      ]
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_partial_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_partial",
          amount: 2000,
          amount_captured: 2000,
          amount_refunded: 500,
          payment_intent: "pi_partial"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      {
        p_checkout_session_id: "cs_partial",
        p_reason: "refund",
        p_clawback_seconds: 300
      }
    );
  });

  it("passes null clawback (full void) when the refund covers the full captured amount", async () => {
    mockCheckoutSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: "cs_full",
          amount_total: 2000,
          metadata: {
            checkoutKind: "voice_bonus_seconds",
            businessId: "biz_full",
            voiceSeconds: "1200"
          }
        }
      ]
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_full_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_full",
          amount: 2000,
          amount_captured: 2000,
          amount_refunded: 2000,
          payment_intent: "pi_full"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      {
        p_checkout_session_id: "cs_full",
        p_reason: "refund",
        p_clawback_seconds: null
      }
    );
  });
});

describe("stripe webhook helpers", () => {
  it("accepts positive integer strings within the hard max", () => {
    expect(parseVoiceBonusSecondsFromMetadata("1800")).toBe(1800);
    expect(parseVoiceBonusSecondsFromMetadata("31536000")).toBe(31536000);
  });

  it("rejects invalid metadata values", () => {
    expect(parseVoiceBonusSecondsFromMetadata(null)).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata(undefined)).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("0")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("-1")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("1.5")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("1e3")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("0x10")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("31536001")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("9999999999")).toBeNull();
  });

  it("returns null for full refunds so the caller does a full void", () => {
    expect(computeVoiceBonusClawbackSeconds(50, 50, 600)).toBeNull();
  });

  it("returns a rounded proportional clawback for partial refunds", () => {
    expect(computeVoiceBonusClawbackSeconds(100, 25, 1800)).toBe(450);
    expect(computeVoiceBonusClawbackSeconds(50, 1, 300)).toBe(6);
  });

  it("returns zero for zero-amount clawbacks and null when inputs are unusable", () => {
    expect(computeVoiceBonusClawbackSeconds(100, 0, 1800)).toBe(0);
    expect(computeVoiceBonusClawbackSeconds(0, 10, 1800)).toBeNull();
    expect(computeVoiceBonusClawbackSeconds(100, 10, 0)).toBeNull();
  });
});
