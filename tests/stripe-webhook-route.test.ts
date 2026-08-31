import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn().mockResolvedValue({
    current_period_start: 1700000000,
    current_period_end: 1702678400
  })
}));

const { mockStripeCancel } = vi.hoisted(() => ({
  mockStripeCancel: vi.fn().mockResolvedValue({ id: "cancelled_sub", status: "canceled" })
}));

const { mockStripeScheduleRelease } = vi.hoisted(() => ({
  mockStripeScheduleRelease: vi.fn().mockResolvedValue({})
}));

const { mockCheckoutSessionsList } = vi.hoisted(() => ({
  mockCheckoutSessionsList: vi.fn()
}));

const { mockRefundsList, mockInvoicesRetrieve } = vi.hoisted(() => ({
  mockRefundsList: vi.fn().mockResolvedValue({ data: [] }),
  mockInvoicesRetrieve: vi.fn()
}));

const {
  mockLoadLifecycleContext,
  mockExecuteLifecyclePlan,
  mockExecuteLifecyclePlanFastPhase,
  mockExecuteLifecyclePlanSlowPhase
} = vi.hoisted(() => ({
  mockLoadLifecycleContext: vi.fn(),
  mockExecuteLifecyclePlan: vi.fn(),
  mockExecuteLifecyclePlanFastPhase: vi.fn(),
  mockExecuteLifecyclePlanSlowPhase: vi.fn()
}));

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => void | Promise<void>>
}));

// `after()` from `next/server` requires the Next.js work-units context
// (only present inside the actual Next runtime). In tests we run the
// route handler bare, so polyfill it to record callbacks; tests that
// need the slow phase to have executed call `flushAfterCallbacks()`.
// (Mirrors the polyfill in `tests/api-billing-cancel-route.test.ts`.)
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => void | Promise<void>) => {
      afterCallbacks.push(cb);
    }
  };
});

async function flushAfterCallbacks() {
  while (afterCallbacks.length > 0) {
    const cb = afterCallbacks.shift();
    if (!cb) continue;
    try {
      await cb();
    } catch {
      // The route's own try/catch is what tests assert on; the polyfill
      // just makes sure the callback runs.
    }
  }
}

const { mockRunChangePlanFromCheckout, mockRunResubscribeFromCheckout } = vi.hoisted(() => ({
  mockRunChangePlanFromCheckout: vi.fn().mockResolvedValue(undefined),
  mockRunResubscribeFromCheckout: vi.fn().mockResolvedValue(undefined)
}));

// Stub only the heavy orchestrators, keep the real
// `cancelStripeSubscriptionSafely` so existing assertions on
// `mockStripeCancel` (which the real impl calls under the hood) still
// hold.
vi.mock("@/lib/billing/change-plan-orchestrator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/billing/change-plan-orchestrator")>();
  return {
    ...actual,
    runChangePlanFromCheckout: mockRunChangePlanFromCheckout,
    runResubscribeFromCheckout: mockRunResubscribeFromCheckout
  };
});

vi.mock("@/lib/stripe/client", () => ({
  ensureCommitmentSchedule: vi.fn(),
  verifyWebhook: vi.fn(),
  getStripe: vi.fn(() => ({
    subscriptions: { retrieve: mockStripeRetrieve, cancel: mockStripeCancel },
    subscriptionSchedules: { release: mockStripeScheduleRelease },
    checkout: { sessions: { list: mockCheckoutSessionsList } },
    refunds: { list: mockRefundsList },
    invoices: { retrieve: mockInvoicesRetrieve }
  }))
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    getSubscription: vi.fn(),
    getSubscriptionByStripeSubscriptionId: vi.fn(),
    updateSubscription: vi.fn(),
    cancelUnpaidPendingSiblings: vi.fn().mockResolvedValue(0)
  };
});

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  recordWhiteGlovePurchase: vi.fn(),
  setPrioritySupportUntil: vi.fn().mockResolvedValue(undefined),
  clearPrioritySupportNudgeStamp: vi.fn().mockResolvedValue(undefined),
  updateBusinessOwnerEmailIfPending: vi.fn().mockResolvedValue(true)
}));

const { mockDisableAutoReloadForBusiness } = vi.hoisted(() => ({
  mockDisableAutoReloadForBusiness: vi.fn().mockResolvedValue(0)
}));

// Dynamically imported inside the handler; vi.mock still intercepts it.
vi.mock("@/lib/db/auto-reload", () => ({
  disableAutoReloadForBusiness: mockDisableAutoReloadForBusiness,
  disableAutoReloadForBusinessesByPaymentMethod: vi.fn().mockResolvedValue(0),
  saveAutoReloadCard: vi.fn().mockResolvedValue(undefined),
  reenableAutoReloadAfterCardAuthorized: vi.fn().mockResolvedValue(0),
  clawbackAutoReloadGrantForCharge: vi.fn().mockResolvedValue(false)
}));

vi.mock("@/lib/db/priority-support", () => ({
  getLivePrioritySupportSubscription: vi.fn().mockResolvedValue(null),
  recordPrioritySupportSubscription: vi.fn(),
  mirrorPrioritySupportSubscription: vi.fn().mockResolvedValue(undefined),
  markPrioritySupportSubscriptionCanceled: vi.fn().mockResolvedValue(undefined)
}));

// Keep the REAL `isPrioritySupportSubscription` / `prioritySupportPeriodEnd`
// so these tests exercise the actual metadata gate the route depends on;
// stub only the side-effectful calls.
vi.mock("@/lib/billing/priority-support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/priority-support")>();
  return {
    ...actual,
    applyPrioritySupportInvoicePaid: vi.fn().mockResolvedValue(true),
    recordPrioritySupportCheckout: vi.fn().mockResolvedValue({ duplicate: false }),
    terminatePrioritySupport: vi.fn().mockResolvedValue(false)
  };
});

vi.mock("@/lib/db/promotions", () => ({
  recordPromotionRedemption: vi.fn()
}));

vi.mock("@/lib/db/white-glove-offers", () => ({
  getWhiteGloveOffer: vi.fn(),
  markWhiteGloveOfferPaid: vi.fn().mockResolvedValue("paid"),
  extendPrioritySupport: vi.fn().mockResolvedValue(undefined),
  attachPaidProspectOfferToBusinessByEmail: vi.fn().mockResolvedValue(null)
}));

const { mockSendOwnerEmail } = vi.hoisted(() => ({
  mockSendOwnerEmail: vi.fn().mockResolvedValue("email_1")
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: mockSendOwnerEmail
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

// Job-ledger wrapper (provisioning_jobs): the route enqueues a durable row
// then runs the orchestrator THROUGH runProvisioningJob. Mock as a thin
// passthrough so the existing orchestrateProvisioning assertions keep
// exercising the exact input mapping.
vi.mock("@/lib/provisioning/jobs", () => ({
  enqueueProvisioningJob: vi.fn().mockResolvedValue(undefined),
  runProvisioningJob: vi.fn(
    async (
      job: { business_id: string; tier: string | null; vps_size: string | null; billing_period: string | null },
      deps: { orchestrate: (input: unknown) => Promise<unknown> }
    ) =>
      deps.orchestrate({
        businessId: job.business_id,
        tier: job.tier,
        vpsSize: job.vps_size,
        billingPeriod: job.billing_period
      })
  )
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: mockLoadLifecycleContext
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: mockExecuteLifecyclePlan,
  executeLifecyclePlanFastPhase: mockExecuteLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase: mockExecuteLifecyclePlanSlowPhase
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
  parseChatCreditMicrosFromMetadata,
  parseSmsBonusTextsFromMetadata,
  parseVoiceBonusSecondsFromMetadata
} from "@/app/api/webhooks/stripe/route";
import { ensureCommitmentSchedule, verifyWebhook } from "@/lib/stripe/client";
import {
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  updateSubscription,
  cancelUnpaidPendingSiblings
} from "@/lib/db/subscriptions";
import { getBusiness, recordWhiteGlovePurchase, updateBusinessOwnerEmailIfPending } from "@/lib/db/businesses";
import { recordPromotionRedemption } from "@/lib/db/promotions";
import {
  getWhiteGloveOffer,
  markWhiteGloveOfferPaid,
  extendPrioritySupport,
  attachPaidProspectOfferToBusinessByEmail
} from "@/lib/db/white-glove-offers";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { logger } from "@/lib/logger";
import {
  applyPrioritySupportInvoicePaid,
  recordPrioritySupportCheckout,
  terminatePrioritySupport
} from "@/lib/billing/priority-support";
import {
  markPrioritySupportSubscriptionCanceled,
  mirrorPrioritySupportSubscription
} from "@/lib/db/priority-support";

describe("stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears CALLS but keeps implementations, so a
    // `mockResolvedValue` set by one test leaks into every later one. That
    // matters for `getSubscription`: the subscription.deleted handler reads it
    // to tell a plan change from a real cancellation, so a leaked active row
    // would silently make later tests take the plan-change path. Reset it to a
    // known state and let each test opt in.
    vi.mocked(getSubscription).mockResolvedValue(null as never);
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
    mockStripeCancel.mockClear();
    mockStripeCancel.mockResolvedValue({ id: "cancelled_sub", status: "canceled" });
    mockStripeScheduleRelease.mockClear();
    mockStripeScheduleRelease.mockResolvedValue({});
    mockLoadLifecycleContext.mockReset();
    mockExecuteLifecyclePlan.mockReset();
    mockExecuteLifecyclePlan.mockResolvedValue({});
    mockExecuteLifecyclePlanFastPhase.mockReset();
    mockExecuteLifecyclePlanFastPhase.mockResolvedValue({});
    mockExecuteLifecyclePlanSlowPhase.mockReset();
    mockExecuteLifecyclePlanSlowPhase.mockResolvedValue(undefined);
    mockRunChangePlanFromCheckout.mockClear();
    mockRunChangePlanFromCheckout.mockResolvedValue(undefined);
    mockRunResubscribeFromCheckout.mockClear();
    mockRunResubscribeFromCheckout.mockResolvedValue(undefined);
    afterCallbacks.length = 0;
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
          subscription: "sub_1",
          customer_details: { email: "owner@example.com" }
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
    expect(updateBusinessOwnerEmailIfPending).toHaveBeenCalledWith(
      "biz_1",
      "owner@example.com"
    );
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
    expect(cancelUnpaidPendingSiblings).toHaveBeenCalledWith("biz_1");
    expect(ensureCommitmentSchedule).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      tier: "starter",
      billingPeriod: "annual"
    });
    // The orchestrator dispatch is deferred via after() (the bare floating
    // promise previously died with the function, Truly Jul 8, KYP Jul 14).
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    await flushAfterCallbacks();
    expect(orchestrateProvisioning).toHaveBeenCalledWith({
      businessId: "biz_1",
      tier: "starter",
      vpsSize: null,
      // Term-aware purchase: the annual contract funds a 1-year Hostinger box.
      billingPeriod: "annual",
      notifyOpsNewSignup: true
    });
  });

  it("records the promotion redemption with what Stripe actually discounted", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_promo",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_promo",
          metadata: {
            businessId: "biz_promo",
            tier: "standard",
            billingPeriod: "biennial",
            promotionId: "44444444-4444-4444-8444-444444444444",
            promotionCode: "SUMMER20"
          },
          customer: "cus_promo",
          subscription: "sub_promo",
          total_details: { amount_discount: 47520 }
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_promo",
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
    expect(recordPromotionRedemption).toHaveBeenCalledWith({
      promotionId: "44444444-4444-4444-8444-444444444444",
      businessId: "biz_promo",
      tier: "standard",
      billingPeriod: "biennial",
      stripeSessionId: "cs_promo",
      amountDiscountedCents: 47520
    });
  });

  it("does not fail an activation when the redemption row cannot be written", async () => {
    vi.mocked(recordPromotionRedemption).mockRejectedValue(new Error("no grant"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_promo_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_promo_fail",
          metadata: {
            businessId: "biz_promo_fail",
            tier: "starter",
            billingPeriod: "monthly",
            promotionId: "44444444-4444-4444-8444-444444444444"
          },
          customer: "cus_promo_fail",
          subscription: "sub_promo_fail"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_promo_fail",
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

    // The money is already taken; a missing stats row must not 500 the
    // webhook into an endless Stripe retry loop.
    expect(response.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalled();
  });

  it("records nothing when the session carries no promotion", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_no_promo",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_no_promo",
          metadata: { businessId: "biz_np", tier: "starter", billingPeriod: "annual" },
          customer: "cus_np",
          subscription: "sub_np"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_np",
      status: "pending",
      stripe_subscription_id: null
    } as never);

    await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(recordPromotionRedemption).not.toHaveBeenCalled();
  });

  it("skips the commitment schedule when a FRESH re-read shows auto-renew was just enabled (webhook race)", async () => {
    // The owner toggles auto-renew ON (schedule released, flag flipped)
    // while this activation webhook is mid-flight. The handler must
    // re-read the flag before creating the schedule instead of trusting
    // the snapshot loaded at handler start.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_autorenew_race",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: {
            businessId: "biz_ar",
            tier: "standard",
            billingPeriod: "biennial"
          },
          customer: "cus_ar",
          subscription: "sub_ar"
        }
      }
    } as never);
    // Stale snapshot: auto-renew OFF at handler start.
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_ar",
      status: "pending",
      stripe_subscription_id: null,
      contract_auto_renew: false
    } as never);
    // Fresh re-read right before the schedule call: auto-renew now ON.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_ar",
      status: "active",
      stripe_subscription_id: "sub_ar",
      contract_auto_renew: true
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(ensureCommitmentSchedule).not.toHaveBeenCalled();
  });

  it("falls back to the snapshot's auto-renew flag when the fresh re-read misses", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_autorenew_fallback",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: {
            businessId: "biz_arf",
            tier: "standard",
            billingPeriod: "biennial"
          },
          customer: "cus_arf",
          subscription: "sub_arf"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_arf",
      status: "pending",
      stripe_subscription_id: null,
      contract_auto_renew: true
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(ensureCommitmentSchedule).not.toHaveBeenCalled();
  });

  it("mirrors Stripe's live cancel_at_period_end on activation when the portal toggle landed during the activation race", async () => {
    // Regression: `customer.subscription.created/updated` deliberately
    // skips rows with no `stripe_subscription_id` linkage (that
    // linkage is only ever planted here, so allowing the
    // subscription.{created,updated} mirror to adopt a pending row
    // would open a lifetime-cap bypass on weak webhook ordering).
    // That's correct for the common case, but if a customer
    // immediately clicks "End at period end" in the Stripe portal
    // during the activation race window, the prior mirror skip would
    // silently lose the flag, no `customer.subscription.updated`
    // would be re-delivered after our `checkout.session.completed`
    // plants the linkage. Reconcile by reading the live Stripe sub's
    // `cancel_at_period_end` here and applying it inline so the
    // dashboard immediately reflects user intent.
    mockStripeRetrieve.mockResolvedValueOnce({
      current_period_start: 1700000000,
      current_period_end: 1702678400,
      cancel_at_period_end: true
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_race",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_race",
          metadata: {
            businessId: "biz_race",
            tier: "starter",
            billingPeriod: "annual"
          },
          customer: "cus_race",
          subscription: "sub_race"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_race",
      status: "pending",
      stripe_subscription_id: null,
      cancel_at_period_end: false
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    // Linkage write (planted before increment) AND the final
    // activation write both carry the live cancel_at_period_end.
    const cancelAtPeriodEndPatches = vi
      .mocked(updateSubscription)
      .mock.calls.map(([, patch]) => (patch as { cancel_at_period_end?: boolean }).cancel_at_period_end);
    expect(cancelAtPeriodEndPatches).toContain(true);
    // The final activation write specifically must carry the flag,
    // that's the row state the dashboard reads after the activation.
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_race",
      expect.objectContaining({
        status: "active",
        cancel_at_period_end: true
      })
    );
  });

  it("does not activate checkout sessions without a local subscription row", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_no_local_sub",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_no_local_sub",
          metadata: {
            businessId: "biz_missing",
            tier: "starter",
            billingPeriod: "annual"
          },
          customer: "cus_1",
          subscription: "sub_1"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "checkout activation skipped: no local subscription row found",
      expect.objectContaining({ businessId: "biz_missing" })
    );
  });

  it("does not overwrite previously linked stripe ids with null on a session missing subscription/customer", async () => {
    // Defensive branch: a Checkout Session webhook that (for whatever
    // reason, retry races, unusual metadata, a `mode=payment` session
    // that slips past the earlier voice-bonus guard) carries neither a
    // `subscription` nor a `customer` field must NOT clobber a
    // previously-linked `stripe_subscription_id` / `stripe_customer_id`
    // on the local row with null.
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_null_ids",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_null_ids",
          metadata: {
            businessId: "biz_linked",
            tier: "starter",
            billingPeriod: "annual"
          },
          customer: null,
          subscription: null
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_linked",
      status: "pending",
      stripe_customer_id: "cus_prev",
      stripe_subscription_id: "sub_prev",
      customer_profile_id: "prof-prev"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    // The linkage-planting write at the top of activateCheckoutSession is
    // gated on `subscriptionId`, so it should NOT fire when null. The
    // final status-flip write should still happen, but MUST omit the
    // nullable fields so the previously-linked ids are preserved.
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(updateSubscription).mock.calls[0];
    expect(patch).toMatchObject({ status: "active" });
    expect(patch).not.toHaveProperty("stripe_subscription_id");
    expect(patch).not.toHaveProperty("stripe_customer_id");
  });

  it("does not overwrite a previously linked stripe_customer_id with null on the linkage-planting write when the session carries a subscription but no customer", async () => {
    // Regression: the FIRST activation write (the linkage-planting branch
    // gated on `!alreadyLinkedToThisStripeSub && subscriptionId`) must
    // apply the same null-clobber defense as the SECOND activation write
    // (the status-flip branch). A degenerate Stripe session that carries
    // a subscription id but lacks a customer id (retry races, mode=
    // payment sessions slipping past the bonus guard, etc.) was
    // previously writing `stripe_customer_id: null` on the linkage
    // plant, silently orphaning a customer linkage planted by a prior
    // `customer.subscription.created` mirror or earlier checkout retry.
    // The defensive policy must be uniform across both writes.
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_link_no_customer",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_link_no_customer",
          metadata: {
            businessId: "biz_link_nc",
            tier: "starter",
            billingPeriod: "annual"
          },
          customer: null,
          subscription: "sub_new_linked"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_link_nc",
      status: "pending",
      stripe_customer_id: "cus_prev_linked",
      stripe_subscription_id: null,
      customer_profile_id: "prof-link-nc"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    // BOTH activation writes must omit `stripe_customer_id` (because
    // the session payload's customer is null), so the previously-
    // linked `cus_prev_linked` value on the local row is preserved.
    expect(updateSubscription).toHaveBeenCalledTimes(2);
    for (const [, patch] of vi.mocked(updateSubscription).mock.calls) {
      expect(patch).not.toHaveProperty("stripe_customer_id");
    }
    // The first call is the linkage-planting write, it must still
    // adopt the new `stripe_subscription_id` so the local row is
    // linked to the freshly-paid Stripe sub.
    const [, linkagePatch] = vi.mocked(updateSubscription).mock.calls[0];
    expect(linkagePatch).toMatchObject({ stripe_subscription_id: "sub_new_linked" });
    // The second call is the status flip, it must carry `status:
    // "active"` and similarly avoid clobbering the customer id.
    const [, statusPatch] = vi.mocked(updateSubscription).mock.calls[1];
    expect(statusPatch).toMatchObject({ status: "active" });
  });

  it("does not activate when the atomic lifetime increment rejects and cancels the fresh Stripe sub", async () => {
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        return Promise.resolve({ data: null, error: { message: "cap reached" } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_cap_block",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_cap_block",
          metadata: {
            businessId: "biz_1",
            tier: "starter",
            billingPeriod: "annual",
            customerProfileId: "prof-capped"
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
    // Linkage write MUST happen first (our idempotency marker), a
    // retry would re-enter this branch and double-increment without it.
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_1",
      expect.objectContaining({
        stripe_subscription_id: "sub_1",
        stripe_customer_id: "cus_1",
        customer_profile_id: "prof-capped"
      })
    );
    // But the status flip to active MUST NOT happen on cap-reject.
    expect(updateSubscription).not.toHaveBeenCalledWith(
      "local_sub_1",
      expect.objectContaining({ status: "active" })
    );
    // The fresh Stripe sub must be canceled to prevent auto-renewal for
    // a service we won't provision.
    expect(mockStripeCancel).toHaveBeenCalledWith("sub_1", { prorate: false });
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "checkout activation blocked by lifetime count increment",
      expect.objectContaining({ businessId: "biz_1", profileId: "prof-capped" })
    );
  });

  it("treats a Stripe webhook retry after linkage as idempotent (no double-increment)", async () => {
    // Simulate a retry: the local sub row is already linked to the same
    // Stripe subscription id (previous delivery planted the linkage),
    // but the lifetime count has already been incremented in that prior
    // run. Under the old `firstActivation = existing.status !== 'active'`
    // logic this would re-enter and re-increment. With the idempotency
    // guard the increment RPC must NOT be called again.
    let incrementCalls = 0;
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        incrementCalls += 1;
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_retry",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_retry",
          metadata: {
            businessId: "biz_retry",
            tier: "starter",
            billingPeriod: "annual",
            customerProfileId: "prof-retry"
          },
          customer: "cus_retry",
          subscription: "sub_retry"
        }
      }
    } as never);
    // Key: stripe_subscription_id on the existing row already matches the
    // session's subscription id, classic retry signature.
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_retry",
      status: "pending",
      stripe_subscription_id: "sub_retry",
      customer_profile_id: "prof-retry"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(incrementCalls).toBe(0);
    // The final status flip still runs (idempotent).
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_retry",
      expect.objectContaining({ status: "active" })
    );
    expect(mockStripeCancel).not.toHaveBeenCalled();
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

  it("records SMS bonus grant on payment checkout with sms_bonus_texts metadata", async () => {
    const bid = "00000000-0000-4000-8000-000000000011";
    const periodEndSec = 1702678400;
    const createdSec = 1700000000;
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_sms",
      business_id: bid,
      status: "active",
      stripe_subscription_id: "sub_sms_1"
    } as never);
    mockStripeRetrieve.mockResolvedValue({
      status: "active",
      current_period_start: 1700000000,
      current_period_end: periodEndSec
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_sms_bonus",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_sms_bonus",
          mode: "payment",
          created: createdSec,
          metadata: {
            checkoutKind: "sms_bonus_texts",
            businessId: bid,
            smsTexts: "500"
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
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "apply_sms_bonus_grant_from_checkout",
      expect.objectContaining({
        p_business_id: bid,
        p_checkout_session_id: "cs_test_sms_bonus",
        p_texts_purchased: 500,
        p_expires_at: expectedExpires
      })
    );
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("records chat credit grant on payment checkout with chat_credit_micros metadata", async () => {
    const bid = "00000000-0000-4000-8000-000000000012";
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_chat",
      business_id: bid,
      status: "active",
      stripe_subscription_id: "sub_chat_1"
    } as never);
    mockStripeRetrieve.mockResolvedValue({
      status: "trialing",
      current_period_start: 1700000000,
      current_period_end: 1702678400
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_chat_credit",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_chat_credit",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "chat_credit_micros",
            businessId: bid,
            creditMicros: "5000000"
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
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "apply_chat_credit_grant_from_checkout",
      expect.objectContaining({
        p_business_id: bid,
        p_checkout_session_id: "cs_test_chat_credit",
        p_credit_micros: 5_000_000
      })
    );
  });

  it("records a white-glove purchase and sends the confirmation email", async () => {
    const bid = "00000000-0000-4000-8000-000000000031";
    const createdSec = 1700000000;
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com",
      white_glove_package: null
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_ok",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_ok",
          mode: "payment",
          created: createdSec,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGlovePackage: "setup"
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
    const purchasedAt = new Date(createdSec * 1000);
    const supportUntil = new Date(purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(recordWhiteGlovePurchase).toHaveBeenCalledWith(bid, {
      packageId: "setup",
      purchasedAt,
      prioritySupportUntil: supportUntil
    });
    expect(mockSendOwnerEmail).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringContaining("White-glove setup"),
      expect.objectContaining({ text: expect.any(String), html: expect.any(String) })
    );
    delete process.env.RESEND_API_KEY;
  });

  it("records the white-glove purchase but skips the email when RESEND_API_KEY is unset", async () => {
    const bid = "00000000-0000-4000-8000-000000000032";
    delete process.env.RESEND_API_KEY;
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com",
      white_glove_package: "setup"
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_no_key",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_no_key",
          mode: "payment",
          // No `created` → the handler falls back to Date.now().
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGlovePackage: "buildout"
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
    expect(recordWhiteGlovePurchase).toHaveBeenCalledWith(
      bid,
      expect.objectContaining({ packageId: "buildout" })
    );
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("still returns 200 when the white-glove confirmation email fails", async () => {
    const bid = "00000000-0000-4000-8000-000000000033";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com",
      white_glove_package: null
    } as never);
    mockSendOwnerEmail.mockRejectedValueOnce(new Error("resend down"));

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_email_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_email_fail",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGlovePackage: "setup"
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
    expect(recordWhiteGlovePurchase).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "white_glove_package confirmation email failed",
      expect.objectContaining({ businessId: bid })
    );
    delete process.env.RESEND_API_KEY;
  });

  it("ignores a white-glove setup completion when buildout is already owned", async () => {
    const bid = "00000000-0000-4000-8000-000000000034";
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com",
      white_glove_package: "buildout"
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_downgrade",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_downgrade",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGlovePackage: "setup"
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
    expect(recordWhiteGlovePurchase).not.toHaveBeenCalled();
  });

  it("skips white-glove recording on missing businessId, unknown package, or unknown business", async () => {
    const cases = [
      {
        id: "cs_wg_no_biz",
        metadata: { checkoutKind: "white_glove_package", whiteGlovePackage: "setup" },
        business: null
      },
      {
        id: "cs_wg_bad_pkg",
        metadata: {
          checkoutKind: "white_glove_package",
          businessId: "00000000-0000-4000-8000-000000000035",
          whiteGlovePackage: "platinum"
        },
        business: null
      },
      {
        id: "cs_wg_ghost_biz",
        metadata: {
          checkoutKind: "white_glove_package",
          businessId: "00000000-0000-4000-8000-000000000036",
          whiteGlovePackage: "setup"
        },
        business: null
      }
    ];

    for (const testCase of cases) {
      vi.mocked(getBusiness).mockResolvedValue(testCase.business as never);
      vi.mocked(verifyWebhook).mockReturnValue({
        id: `evt_${testCase.id}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: testCase.id,
            mode: "payment",
            created: 1700000000,
            metadata: testCase.metadata
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
    }
    expect(recordWhiteGlovePurchase).not.toHaveBeenCalled();
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("records a CUSTOM white-glove offer payment: marks paid, extends support, emails", async () => {
    const bid = "00000000-0000-4000-8000-000000000041";
    const offerId = "00000000-0000-4000-8000-00000000004f";
    const createdSec = 1700000000;
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com",
      white_glove_package: null
    } as never);
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: bid,
      name: "White-glove migration",
      description: "",
      amount_cents: 125_000,
      status: "open",
      created_by: "admin@example.com",
      created_at: "2026-07-01T00:00:00Z",
      paid_at: null,
      stripe_session_id: null
    } as never);

    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_offer_ok",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_offer_ok",
          mode: "payment",
          created: createdSec,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGlovePackage: "custom",
            whiteGloveOfferId: offerId
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
    const purchasedAt = new Date(createdSec * 1000);
    const supportUntil = new Date(purchasedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(markWhiteGloveOfferPaid).toHaveBeenCalledWith(offerId, {
      paidAt: purchasedAt,
      stripeSessionId: "cs_wg_offer_ok"
    });
    expect(extendPrioritySupport).toHaveBeenCalledWith(bid, supportUntil);
    // The fixed-package column must never be touched by a custom offer.
    expect(recordWhiteGlovePurchase).not.toHaveBeenCalled();
    expect(mockSendOwnerEmail).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringContaining("White-glove migration"),
      expect.objectContaining({ text: expect.any(String), html: expect.any(String) })
    );
    delete process.env.RESEND_API_KEY;
  });

  it("ignores a custom-offer completion for an unknown or mismatched offer", async () => {
    const bid = "00000000-0000-4000-8000-000000000042";
    const offerId = "00000000-0000-4000-8000-00000000005f";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com"
    } as never);

    const offers = [
      null,
      // Belongs to a different business: never cross-credit.
      {
        id: offerId,
        business_id: "00000000-0000-4000-8000-0000000000ff",
        name: "X",
        status: "open"
      }
    ];
    for (const offer of offers) {
      vi.mocked(getWhiteGloveOffer).mockResolvedValue(offer as never);
      vi.mocked(verifyWebhook).mockReturnValue({
        id: `evt_wg_offer_bad_${offer ? "mismatch" : "missing"}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_wg_offer_bad",
            mode: "payment",
            created: 1700000000,
            metadata: {
              checkoutKind: "white_glove_package",
              businessId: bid,
              whiteGloveOfferId: offerId
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
    }
    expect(markWhiteGloveOfferPaid).not.toHaveBeenCalled();
    expect(extendPrioritySupport).not.toHaveBeenCalled();
    delete process.env.RESEND_API_KEY;
  });

  it("records a custom-offer payment but skips the email for an unknown business or unset key", async () => {
    const bid = "00000000-0000-4000-8000-000000000043";
    const offerId = "00000000-0000-4000-8000-00000000006f";
    const offer = {
      id: offerId,
      business_id: bid,
      name: "Deal",
      status: "open"
    };

    // Unknown business: nothing is written at all.
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getWhiteGloveOffer).mockResolvedValue(offer as never);
    vi.mocked(getBusiness).mockResolvedValue(null);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_offer_ghost_biz",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_offer_ghost",
          mode: "payment",
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGloveOfferId: offerId
          }
        }
      }
    } as never);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/webhooks/stripe", {
            method: "POST",
            headers: { "stripe-signature": "sig" },
            body: "{}"
          })
        )
      ).status
    ).toBe(200);
    expect(markWhiteGloveOfferPaid).not.toHaveBeenCalled();

    // No RESEND key (and no `created` → Date.now() fallback): paid + extended, no email.
    delete process.env.RESEND_API_KEY;
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_offer_no_key",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_offer_no_key",
          mode: "payment",
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGloveOfferId: offerId
          }
        }
      }
    } as never);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/webhooks/stripe", {
            method: "POST",
            headers: { "stripe-signature": "sig" },
            body: "{}"
          })
        )
      ).status
    ).toBe(200);
    expect(markWhiteGloveOfferPaid).toHaveBeenCalled();
    expect(extendPrioritySupport).toHaveBeenCalled();
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
  });

  it("records a PROSPECT offer payment: marks paid, no business writes, emails the recipient", async () => {
    const offerId = "00000000-0000-4000-8000-00000000009f";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: null,
      name: "Founding deal",
      description: "",
      amount_cents: 50_000,
      status: "open",
      recipient_email: "prospect@example.com",
      pay_token: "tok-p",
      created_by: "admin@example.com",
      created_at: "2026-07-06T00:00:00Z",
      paid_at: null,
      stripe_session_id: null
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_prospect",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_prospect",
          mode: "payment",
          created: 1700000000,
          // No businessId metadata: paid via the public /offer link pre-account.
          metadata: {
            checkoutKind: "white_glove_package",
            whiteGlovePackage: "custom",
            whiteGloveOfferId: offerId
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
    expect(markWhiteGloveOfferPaid).toHaveBeenCalledWith(offerId, {
      paidAt: new Date(1700000000 * 1000),
      stripeSessionId: "cs_wg_prospect"
    });
    // The webhook TRIES to attach to an existing account for the RECIPIENT
    // (never the Stripe payer); none exists here, so no window.
    expect(attachPaidProspectOfferToBusinessByEmail).toHaveBeenCalledWith(
      offerId,
      "prospect@example.com"
    );
    expect(extendPrioritySupport).not.toHaveBeenCalled();
    expect(recordWhiteGlovePurchase).not.toHaveBeenCalled();
    expect(mockSendOwnerEmail).toHaveBeenCalledWith(
      "resend_test",
      "prospect@example.com",
      expect.stringContaining("Founding deal"),
      expect.objectContaining({ text: expect.any(String), html: expect.any(String) })
    );
    delete process.env.RESEND_API_KEY;
  });

  it("opens the priority window when a paid prospect offer attaches to an EXISTING account", async () => {
    const offerId = "00000000-0000-4000-8000-0000000000bf";
    const existingBiz = "00000000-0000-4000-8000-0000000000be";
    delete process.env.RESEND_API_KEY;
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: null,
      name: "Deal",
      status: "open",
      recipient_email: "prospect@example.com"
    } as never);
    vi.mocked(attachPaidProspectOfferToBusinessByEmail).mockResolvedValueOnce(existingBiz);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_prospect_existing",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_prospect_existing",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            whiteGloveOfferId: offerId
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
    expect(extendPrioritySupport).toHaveBeenCalledWith(existingBiz, expect.any(Date));
  });

  it("still records a prospect payment when the attach lookup fails", async () => {
    const offerId = "00000000-0000-4000-8000-0000000000cf";
    delete process.env.RESEND_API_KEY;
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: null,
      name: "Deal",
      status: "open",
      recipient_email: "prospect@example.com"
    } as never);
    vi.mocked(attachPaidProspectOfferToBusinessByEmail).mockRejectedValueOnce(
      new Error("lookup down")
    );
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_prospect_attach_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_prospect_attach_fail",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            whiteGloveOfferId: offerId
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
    expect(markWhiteGloveOfferPaid).toHaveBeenCalled();
    expect(extendPrioritySupport).not.toHaveBeenCalled();
  });

  it("falls back to the Stripe payer email for a prospect offer without recipient_email", async () => {
    const offerId = "00000000-0000-4000-8000-0000000000af";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: null,
      name: "Deal",
      status: "open",
      recipient_email: null
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_prospect_payer",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_prospect_payer",
          mode: "payment",
          created: 1700000000,
          customer_details: { email: "payer@example.com" },
          metadata: {
            checkoutKind: "white_glove_package",
            whiteGloveOfferId: offerId
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
    expect(mockSendOwnerEmail).toHaveBeenCalledWith(
      "resend_test",
      "payer@example.com",
      expect.any(String),
      expect.anything()
    );
    delete process.env.RESEND_API_KEY;
  });

  it("does not re-credit a duplicate-session completion of an already-paid offer", async () => {
    const bid = "00000000-0000-4000-8000-000000000045";
    const offerId = "00000000-0000-4000-8000-00000000008f";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: bid,
      name: "Deal",
      status: "paid",
      stripe_session_id: "cs_first",
      amount_cents: 125_000
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com"
    } as never);
    vi.mocked(markWhiteGloveOfferPaid).mockResolvedValueOnce("duplicate_session");
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_offer_dup",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_second",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGloveOfferId: offerId
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
    // No support extension and no confirmation email for the second charge,
    // it gets flagged for a refund instead.
    expect(extendPrioritySupport).not.toHaveBeenCalled();
    expect(mockSendOwnerEmail).not.toHaveBeenCalled();
    delete process.env.RESEND_API_KEY;
  });

  it("still returns 200 when the custom-offer confirmation email fails", async () => {
    const bid = "00000000-0000-4000-8000-000000000044";
    const offerId = "00000000-0000-4000-8000-00000000007f";
    process.env.RESEND_API_KEY = "resend_test";
    vi.mocked(getWhiteGloveOffer).mockResolvedValue({
      id: offerId,
      business_id: bid,
      name: "Deal",
      status: "open"
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: bid,
      owner_email: "owner@example.com"
    } as never);
    mockSendOwnerEmail.mockRejectedValueOnce(new Error("resend down"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_wg_offer_email_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_wg_offer_email_fail",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "white_glove_package",
            businessId: bid,
            whiteGloveOfferId: offerId
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
    expect(markWhiteGloveOfferPaid).toHaveBeenCalled();
    delete process.env.RESEND_API_KEY;
  });

  it("does not record SMS bonus grant when smsTexts metadata is invalid", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_sms_bad_meta",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sms_bad_meta",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "sms_bonus_texts",
            businessId: "00000000-0000-4000-8000-000000000013",
            smsTexts: "1.5e3"
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

  it("does not record chat credit grant without an active subscription row", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_chat_block",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_chat_block",
          mode: "payment",
          created: 1700000000,
          metadata: {
            checkoutKind: "chat_credit_micros",
            businessId: "00000000-0000-4000-8000-000000000014",
            creditMicros: "5000000"
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

  it("leaves pending subscription untouched on invoice.payment_failed (no canceled-row spoof on dashboard)", async () => {
    // Regression: previously the `invoice.payment_failed` handler
    // wrote `status: "canceled"` + `canceled_at` + `cancel_reason:
    // "payment_failed"` for pending rows. The PR's overall design
    // treats `pending → discard` as the correct semantic (matching
    // the parallel `checkout.session.async_payment_failed` handler
    // above), and the abandoned-subs cleanup job is responsible for
    // pruning the row + business. Flipping pending rows to canceled
    // here surfaced a misleading "canceled" plan card on the
    // dashboard for a user whose workspace was never actually
    // provisioned. Take no DB action; just log.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_pending_invfail",
      business_id: "biz_pending_invfail",
      status: "pending",
      stripe_subscription_id: "sub_pending_invfail"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_pending_invfail",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_pending_invfail",
          parent: {
            subscription_details: { subscription: "sub_pending_invfail" }
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
    // No autoCancel dispatch either, that's the active-row path only.
    expect(afterCallbacks.length).toBe(0);
  });

  it("does not clobber a canceled lifecycle row when Stripe keeps sending dunning statuses", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
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

  // /api/billing/reactivate re-enables Hostinger auto-renew on undoPeriodEnd.
  // The Stripe customer portal reaches the same state through this webhook,
  // which only mirrored the flag. billing-posture excludes cancel_at_period_end
  // tenants from its heal, so the box only got renewal back on the next daily
  // run: a customer who undoes on their Hostinger renewal day could lose it.
  it("re-enables Hostinger auto-renew when the portal undoes a scheduled cancel", async () => {
    const existing = {
      id: "local_sub_undo",
      status: "active",
      business_id: "biz_undo",
      stripe_subscription_id: "sub_undo",
      cancel_at_period_end: true,
      hostinger_billing_subscription_id: "hbs_undo",
      customer_profile_id: "cus_undo"
    };
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(existing as never);
    mockLoadLifecycleContext.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: {
        // Faithful to production: loadLifecycleContextForBusiness re-reads the
        // row AFTER the mirror above cleared cancel_at_period_end.
        subscription: { ...existing, cancel_at_period_end: false },
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "user-1",
        profile: null,
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        vpsProvider: "hostinger",
        vpsNeverRenew: false,
        now: new Date("2026-05-01T00:00:00.000Z")
      }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_portal_undo",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_undo",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_undo" }
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
    await Promise.all(afterCallbacks.map((cb) => cb()));

    // The Hostinger half only: no Stripe or DB ops, since the portal already
    // did those and this webhook already mirrored them.
    expect(mockExecuteLifecyclePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [],
        dbUpdates: [],
        sshOps: [],
        telnyxOps: [],
        hostingerOps: [
          expect.objectContaining({ type: "enable_billing_auto_renewal" })
        ]
      }),
      expect.anything()
    );
  });

  // Sunk-cost hardware must lapse even when the tenant stays. Same flag
  // adoptVps and the billing-posture heal honor.
  it("leaves a never_renew box non-renewing on a portal undo", async () => {
    const existing = {
      id: "local_sub_nr",
      status: "active",
      business_id: "biz_nr",
      stripe_subscription_id: "sub_nr",
      cancel_at_period_end: true,
      hostinger_billing_subscription_id: "hbs_nr"
    };
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(existing as never);
    mockLoadLifecycleContext.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: {
        subscription: { ...existing, cancel_at_period_end: false },
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "user-1",
        profile: null,
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        vpsProvider: "hostinger",
        vpsNeverRenew: true,
        now: new Date("2026-05-01T00:00:00.000Z")
      }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_portal_undo_nr",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_nr",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_nr" }
        }
      }
    } as never);

    await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
    await Promise.all(afterCallbacks.map((cb) => cb()));

    expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
  });

  // A failed periodEndReached fallback can deliver a canceled subscription
  // whose cancel_at_period_end has been cleared. That must not hand the box
  // back its renewal while the mirror writes status canceled.
  it("does not re-enable renewal when the subscription is no longer active", async () => {
    const existing = {
      id: "local_sub_dead",
      status: "active",
      business_id: "biz_dead",
      stripe_subscription_id: "sub_dead",
      cancel_at_period_end: true,
      hostinger_billing_subscription_id: "hbs_dead"
    };
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(existing as never);
    mockLoadLifecycleContext.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: {
        subscription: { ...existing, status: "canceled", cancel_at_period_end: false },
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "user-1",
        profile: null,
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        vpsProvider: "hostinger",
        vpsNeverRenew: false,
        now: new Date("2026-05-01T00:00:00.000Z")
      }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_portal_undo_dead",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_dead",
          status: "canceled",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_dead" }
        }
      }
    } as never);

    await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
    await Promise.all(afterCallbacks.map((cb) => cb()));

    expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
  });

  // The packs a tenant carries live only in Stripe metadata, so nothing
  // server-rendered could see them and change-plan started from an empty
  // selection, silently dropping them.
  it("mirrors the recurring pack add-ons onto the local row", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_packs",
      status: "active",
      business_id: "biz_packs",
      stripe_subscription_id: "sub_packs",
      cancel_at_period_end: false
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_packs",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_packs",
          status: "active",
          cancel_at_period_end: false,
          metadata: {
            businessId: "biz_packs",
            addonVoice: "min_30:2:1800",
            addonSms: "texts_500:1:500"
          }
        }
      }
    } as never);

    const res = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
    expect(res.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_packs",
      expect.objectContaining({
        // Only the pack keys, and in Stripe's own encoding so there is one
        // format to keep in step rather than two.
        membership_pack_addons: { addonVoice: "min_30:2:1800", addonSms: "texts_500:1:500" }
      })
    );
  });

  it("clears the mirror when a subscription carries no packs", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_nopacks",
      status: "active",
      business_id: "biz_nopacks",
      stripe_subscription_id: "sub_nopacks",
      cancel_at_period_end: false
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_nopacks",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_nopacks",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_nopacks" }
        }
      }
    } as never);

    await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_nopacks",
      expect.objectContaining({ membership_pack_addons: null })
    );
  });

  it("mirrors subscription updates onto the row matching the Stripe subscription id", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "old_sub_row",
      business_id: "biz_change",
      status: "active",
      stripe_subscription_id: "sub_old"
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "new_sub_row",
      business_id: "biz_change",
      status: "active",
      stripe_subscription_id: "sub_new"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_old_sub_update",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_old",
          status: "canceled",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_change" },
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
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
    expect(updateSubscription).toHaveBeenCalledWith(
      "old_sub_row",
      expect.objectContaining({
        status: "canceled",
        stripe_subscription_id: "sub_old"
      })
    );
    expect(updateSubscription).not.toHaveBeenCalledWith("new_sub_row", expect.any(Object));
  });

  it("mirrors pause_collection onto the row so an admin pause (or a Stripe auto-resume) is visible", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_paused",
      business_id: "biz_paused",
      status: "active",
      stripe_subscription_id: "sub_paused"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_paused",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_paused",
          status: "active",
          cancel_at_period_end: false,
          pause_collection: { behavior: "void", resumes_at: 1790000000 },
          metadata: { businessId: "biz_paused" }
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
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_paused",
      expect.objectContaining({
        status: "active",
        billing_paused: true,
        billing_pause_resumes_at: new Date(1790000000 * 1000).toISOString()
      })
    );
  });

  it("does NOT tear down a tenant whose collection is paused (pause is a comp, not dunning)", async () => {
    // The admin pause lever sets `pause_collection` while leaving the Stripe
    // status `active`, precisely so this handler's dunning branch
    // (past_due / unpaid / paused, which dispatches
    // autoCancelOnPaymentFailure) never fires on a comped tenant. If a
    // future change ever keyed the teardown on the
    // presence of a pause rather than on the status, a comped customer would
    // silently lose their box.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_comp",
      business_id: "biz_comp",
      status: "active",
      stripe_subscription_id: "sub_comp"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_comp",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_comp",
          status: "active",
          cancel_at_period_end: false,
          pause_collection: { behavior: "void" },
          metadata: { businessId: "biz_comp" }
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
    expect(afterCallbacks.length).toBe(0);
    expect(mockLoadLifecycleContext).not.toHaveBeenCalled();
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_comp",
      expect.objectContaining({
        status: "active",
        billing_paused: true,
        billing_pause_resumes_at: null
      })
    );
  });

  it("does NOT adopt a pending row on early customer.subscription.created (prevents lifetime-cap bypass)", async () => {
    // Stripe does not guarantee webhook ordering. If `customer.subscription
    // .created` arrives before `checkout.session.completed` and we adopted
    // the pending local row here (writing `stripe_subscription_id` + flipping
    // status to active), the subsequent activation would see
    // `alreadyLinkedToThisStripeSub === true` AND `status === "active"`,
    // causing `firstActivation` to be false and silently skipping
    // `incrementLifetimeSubscriptionCount`, a lifetime-cap bypass under
    // ordinary webhook delivery. The handler must mirror ONLY rows that
    // are already linked by stripe_subscription_id.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_created_before_checkout",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_created",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_pending" },
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
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
    expect(getSubscription).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "customer.subscription mirror skipped: no local subscription row for Stripe sub",
      expect.objectContaining({ stripeSubscriptionId: "sub_created", businessId: "biz_pending" })
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
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(existing as never);
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
    // Split-phase: fast phase runs inline (Stripe ops + DB updates that
    // flip status=canceled + grace_ends_at); slow phase (SSH backup +
    // Hostinger ops + email) is deferred via `after()`. The bare
    // `executeLifecyclePlan` MUST NOT be called on this path because a
    // synchronous await would routinely exceed Stripe's ~30s webhook ack
    // window and cause Stripe retries to race duplicate snapshots/
    // backups against the still-running first execution.
    expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
    expect(mockExecuteLifecyclePlanFastPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [],
        hostingerOps: expect.arrayContaining([
          { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
        ])
      }),
      expect.objectContaining({ businessId: "biz_period_end", vpsHost: "1.2.3.4" })
    );
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockExecuteLifecyclePlanSlowPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        hostingerOps: expect.arrayContaining([
          { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-1" }
        ])
      }),
      expect.any(Object)
    );
  });

  it("split-phases periodEndReached on customer.subscription.updated active→canceled (no synchronous SSH/Hostinger work in the ack path)", async () => {
    // Regression: the dispatch path that fires when Stripe transitions a
    // `cancel_at_period_end=true` sub from `active` → `canceled` used
    // to `await executeLifecyclePlan` synchronously. SSH backup +
    // Hostinger snapshot/stop/billing-cancel routinely exceed Stripe's
    // ~30s webhook ack window, so Stripe would retry and race a
    // duplicate run against the still-executing first invocation. The
    // path must mirror the dispatchAutoCancelOnPaymentFailure pattern:
    // run the fast phase inline (so the row reflects cancellation
    // before we ack) and defer the slow phase via `after()`.
    const existing = {
      id: "local_sub_period_end_updated",
      business_id: "biz_period_end_updated",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_period_end_updated",
      tier: "starter",
      status: "active",
      billing_period: "monthly",
      renewal_at: null,
      commitment_months: 1,
      stripe_current_period_start: "2026-04-01T00:00:00.000Z",
      stripe_current_period_end: "2026-05-01T00:00:00.000Z",
      stripe_subscription_cached_at: "2026-04-01T00:00:00.000Z",
      customer_profile_id: "prof-pe-1",
      canceled_at: null,
      cancel_reason: null,
      grace_ends_at: null,
      wiped_at: null,
      vps_stopped_at: null,
      hostinger_billing_subscription_id: "hbs-pe-updated",
      cancel_at_period_end: true,
      stripe_refund_id: null,
      refund_amount_cents: null,
      created_at: "2026-04-01T00:00:00.000Z"
    };
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(existing as never);
    mockLoadLifecycleContext.mockResolvedValue({
      ok: true,
      vpsHost: "9.9.9.9",
      context: {
        subscription: existing,
        ownerEmail: "owner@example.com",
        ownerAuthUserId: "user-1",
        profile: null,
        virtualMachineId: 84,
        vpsHost: "9.9.9.9",
        now: new Date("2026-05-01T00:00:00.000Z")
      }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_period_end_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_period_end_updated",
          status: "canceled",
          cancel_at_period_end: true,
          metadata: { businessId: "biz_period_end_updated" },
          items: {
            data: [
              {
                current_period_start: 1735689600,
                current_period_end: 1738368000
              }
            ]
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
    expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
    expect(mockExecuteLifecyclePlanFastPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        hostingerOps: expect.arrayContaining([
          { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs-pe-updated" }
        ])
      }),
      expect.objectContaining({
        businessId: "biz_period_end_updated",
        vpsHost: "9.9.9.9"
      })
    );
    expect(mockExecuteLifecyclePlanSlowPhase).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockExecuteLifecyclePlanSlowPhase).toHaveBeenCalledTimes(1);
  });

  it("does not rerun period-end teardown when a deleted webhook is replayed after teardown", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
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
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
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

  it("refuses to resurrect a locally-canceled row when Stripe sends an active subscription.updated", async () => {
    // Bug A regression: Stripe can re-deliver `subscription.updated`
    // with `status="active"` for a row our lifecycle has already moved
    // into the canceled/grace state, most commonly when an operator
    // clicks "Resume subscription" in the Stripe dashboard, or on
    // weak webhook ordering during a schedule phase transition.
    // Naively mirroring `status="active"` would leave the row
    // internally inconsistent (status=active alongside grace_ends_at
    // / canceled_at / cancel_reason) and invisible to the grace-sweep
    // cron. The handler must refuse the active-write and let
    // reactivation flow through `/api/billing/reactivate`. We still
    // mirror cancel_at_period_end (UI-only) but MUST NOT re-stamp the
    // period cache (see the dedicated quota-leak regression below).
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_grace",
      business_id: "biz_grace",
      status: "canceled",
      stripe_subscription_id: "sub_grace",
      cancel_at_period_end: false,
      grace_ends_at: "2026-05-24T00:00:00.000Z",
      canceled_at: "2026-04-24T00:00:00.000Z",
      cancel_reason: "user_period_end",
      wiped_at: null
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_resume_active",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_grace",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_grace" },
          items: { data: [{ current_period_start: 1700000000, current_period_end: 1702678400 }] }
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
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    // Critical: the call must NOT include `status: "active"` (would
    // resurrect the row out of the grace-sweep's reach).
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_grace",
      expect.not.objectContaining({ status: expect.anything() })
    );
    // But it should still mirror cancel_at_period_end + the Stripe sub id.
    expect(updateSubscription).toHaveBeenCalledWith(
      "local_sub_grace",
      expect.objectContaining({
        stripe_subscription_id: "sub_grace",
        cancel_at_period_end: false
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "customer.subscription.updated: refusing to resurrect canceled row to active without lifecycle reactivation",
      expect.objectContaining({
        businessId: "biz_grace",
        subscriptionRowId: "local_sub_grace",
        stripeSubscriptionId: "sub_grace"
      })
    );
  });

  it("does NOT re-stamp Stripe period cache onto a canceled-in-grace row (Edge voice quota-leak guard)", async () => {
    // Quota-leak regression: the lifecycle planner and
    // `customer.subscription.deleted` handler both null
    // `stripe_current_period_{start,end}` on cancel so the Edge voice
    // inbound's `cacheLooksValidForQuotaAfterJitFailure` cannot reserve
    // minutes against a stale period after the subscription is gone.
    // If `customer.subscription.updated` arrives with `status="active"`
    // for a canceled row (e.g. operator-clicked "Resume subscription"
    // in the Stripe dashboard, schedule phase transition flipping back
    // to active, or webhook reordering on retry), the resurrection
    // guard refuses the status flip, but it must NOT re-stamp live
    // period bounds either, otherwise the canceled-in-grace row goes
    // back to looking quota-valid and voice usage on the still-running
    // VPS during grace would be billed against a terminated sub.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "local_sub_quota",
      business_id: "biz_quota",
      status: "canceled",
      stripe_subscription_id: "sub_quota",
      cancel_at_period_end: false,
      stripe_current_period_start: null,
      stripe_current_period_end: null,
      stripe_subscription_cached_at: null,
      grace_ends_at: "2026-05-24T00:00:00.000Z",
      canceled_at: "2026-04-24T00:00:00.000Z",
      cancel_reason: "user_period_end",
      wiped_at: null
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_resume_active_with_period",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_quota",
          status: "active",
          cancel_at_period_end: false,
          metadata: { businessId: "biz_quota" },
          // Live period bounds straight from a "Resume" click in the
          // Stripe dashboard, these MUST NOT be mirrored back onto the
          // canceled row.
          items: { data: [{ current_period_start: 1799999000, current_period_end: 1802678400 }] }
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
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(updateSubscription).mock.calls[0];
    // The patch must not contain ANY of the period cache fields, so the
    // explicit nulls written by `customer.subscription.deleted` /
    // lifecycle planner survive intact and the JIT-fail proceed path
    // stays gated.
    expect(patch).not.toHaveProperty("stripe_current_period_start");
    expect(patch).not.toHaveProperty("stripe_current_period_end");
    expect(patch).not.toHaveProperty("stripe_subscription_cached_at");
    // Sanity: status is also still untouched.
    expect(patch).not.toHaveProperty("status");
  });

  it("refuses to relink an active row to a different Stripe sub id (lifetime-cap bypass guard)", async () => {
    // Bug B regression: `firstActivation = existing.status !== "active"
    // && !alreadyLinkedToThisStripeSub`. If we hit the default
    // activation branch with an existing active row already linked to
    // a *different* Stripe subscription id (anomalous: changePlan /
    // resubscribe orchestrators short-circuit at `lifecycleAction`
    // dispatch and never reach this branch), the unconditional
    // linkage update would overwrite stripe_subscription_id without
    // bumping the lifetime counter, a cap bypass. The handler must
    // refuse the relink and cancel the new Stripe sub so the customer
    // isn't auto-renewed for service we won't provision.
    let incrementCalls = 0;
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        incrementCalls += 1;
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_anomalous_relink",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_anomalous",
          metadata: {
            businessId: "biz_anom",
            tier: "starter",
            billingPeriod: "annual",
            customerProfileId: "prof-anom"
          },
          customer: "cus_anom_new",
          subscription: "sub_anom_new"
        }
      }
    } as never);
    // Existing active row was previously linked to a *different*
    // Stripe sub id. Reaching activateCheckoutSession for sub_anom_new
    // is the cap-bypass shape.
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_anom",
      status: "active",
      stripe_subscription_id: "sub_anom_old",
      customer_profile_id: "prof-anom"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    // No relink write.
    expect(updateSubscription).not.toHaveBeenCalled();
    // No silent slot-skip.
    expect(incrementCalls).toBe(0);
    // The new Stripe sub is canceled so it doesn't auto-renew forever.
    expect(mockStripeCancel).toHaveBeenCalledWith("sub_anom_new", { prorate: false });
    expect(logger.error).toHaveBeenCalledWith(
      "checkout activation refused: active row already linked to a different Stripe sub id",
      expect.objectContaining({
        businessId: "biz_anom",
        existingStripeSubscriptionId: "sub_anom_old",
        incomingStripeSubscriptionId: "sub_anom_new"
      })
    );
  });

  it("refuses to resurrect a canceled row from a fresh checkout that bypassed the resubscribe orchestrator", async () => {
    // Bug regression: a fresh `/api/checkout` (no `lifecycleAction=resubscribe`
    // metadata) completes for a business whose local row is already in
    // `status="canceled"` (with grace metadata, possibly already wiped).
    // Without this guard:
    //   - `alreadyLinkedToThisStripeSub === false` (new sub id) and
    //     `firstActivation === true`, so the linkage write silently
    //     attaches the new Stripe sub to the canceled row, the lifetime
    //     counter increments, and the final `status: "active"` write
    //     resurrects the row WITHOUT clearing `grace_ends_at` /
    //     `wiped_at` / `cancel_at` / `cancel_reason`, a Frankenstein
    //     state invisible to the grace-sweep cron (which filters
    //     `status="canceled"`).
    // The handler must refuse and cancel the fresh Stripe sub so the
    // customer isn't billed for service we won't provision; the legit
    // path is `/api/billing/reactivate` (mode=resubscribe).
    let incrementCalls = 0;
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        incrementCalls += 1;
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_canceled_resurrect_attempt",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_canceled_resurrect",
          metadata: {
            businessId: "biz_canceled_resurrect",
            tier: "starter",
            billingPeriod: "annual",
            customerProfileId: "prof-canceled-resurrect"
          },
          customer: "cus_resurrect_new",
          subscription: "sub_resurrect_new"
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_canceled_resurrect",
      status: "canceled",
      stripe_subscription_id: "sub_resurrect_old",
      customer_profile_id: "prof-canceled-resurrect",
      grace_ends_at: "2026-05-24T00:00:00.000Z",
      wiped_at: null
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    // Critical: NO linkage write, NO status flip, NO provisioning trigger.
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(incrementCalls).toBe(0);
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    // The fresh (unlinked) Stripe sub must be canceled so it doesn't
    // auto-renew forever for service we won't provision.
    expect(mockStripeCancel).toHaveBeenCalledWith("sub_resurrect_new", { prorate: false });
    expect(logger.warn).toHaveBeenCalledWith(
      "checkout activation refused: local row is canceled; resubscribe must go through /api/billing/reactivate",
      expect.objectContaining({
        businessId: "biz_canceled_resurrect",
        subscriptionRowId: "local_sub_canceled_resurrect",
        alreadyLinkedToThisStripeSub: false,
        existingStripeSubscriptionId: "sub_resurrect_old",
        incomingStripeSubscriptionId: "sub_resurrect_new",
        graceEndsAt: "2026-05-24T00:00:00.000Z",
        wipedAt: null
      })
    );
  });

  it("silently bails (no Stripe teardown) on a webhook re-delivery where the canceled row is already linked to this sub", async () => {
    // Companion to the test above. When `checkout.session.completed`
    // is re-delivered for a row that legitimately moved to canceled
    // between the original delivery and the retry (e.g. a concurrent
    // `customer.subscription.deleted` flipped it), the Stripe sub is
    // already canceled at Stripe's end, no teardown call needed,
    // just bail to preserve the grace state.
    let incrementCalls = 0;
    mockVoiceBonusRpc.mockImplementation((name: string) => {
      if (name === "increment_customer_profile_lifetime_count") {
        incrementCalls += 1;
        return Promise.resolve({ data: 1, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_canceled_redeliver",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_canceled_redeliver",
          metadata: {
            businessId: "biz_canceled_redeliver",
            tier: "starter",
            billingPeriod: "annual",
            customerProfileId: "prof-canceled-redeliver"
          },
          customer: "cus_redeliver",
          subscription: "sub_redeliver"
        }
      }
    } as never);
    // Same sub id as the incoming event → alreadyLinkedToThisStripeSub.
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_canceled_redeliver",
      status: "canceled",
      stripe_subscription_id: "sub_redeliver",
      customer_profile_id: "prof-canceled-redeliver",
      grace_ends_at: "2026-05-24T00:00:00.000Z",
      wiped_at: null
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
    expect(incrementCalls).toBe(0);
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    // No Stripe teardown on re-delivery: Stripe already canceled the
    // sub (the deleted event is what flipped us to canceled).
    expect(mockStripeCancel).not.toHaveBeenCalled();
  });

  describe("background dispatches survive the 200 ack via after()", () => {
    // Bug regression: the four fire-and-forget dispatches
    // (`dispatchAutoCancelOnPaymentFailure` x2, `runChangePlanFromCheckout`,
    // `runResubscribeFromCheckout`) used to be bare floating promises.
    // On Vercel serverless the function can be torn down shortly after
    // the 200 response is returned, killing the multi-minute SSH backup
    // / Hostinger teardown / new-VM provisioning work mid-flight. They
    // must be scheduled via `after()` (Next.js `waitUntil`) so the
    // runtime keeps the function alive until the work completes.
    //
    // Each test below asserts:
    //   1. The 200 ack is returned BEFORE the heavy work runs (i.e. the
    //      orchestrator/dispatcher hasn't been called by the time POST
    //      resolves).
    //   2. The work was registered via `after()` (visible in
    //      `afterCallbacks`).
    //   3. After flushing the `after()` queue, the dispatcher / orchestrator
    //      actually runs.
    it("schedules autoCancelOnPaymentFailure via after() on subscription.updated→past_due", async () => {
      mockLoadLifecycleContext.mockResolvedValue({
        ok: true,
        context: {
          subscription: { id: "sub_row_pd", status: "active", customer_profile_id: null },
          profile: null,
          now: new Date(),
          vpsHost: null
        },
        vpsHost: null
      } as never);
      vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
        id: "local_sub_pd",
        business_id: "biz_pd",
        status: "active",
        stripe_subscription_id: "sub_pd"
      } as never);
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_pd_active",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_pd",
            status: "past_due",
            cancel_at_period_end: false,
            metadata: { businessId: "biz_pd" }
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
      // Before flushing: the slow work must NOT have run yet (the whole
      // point of `after()` is that it runs after the response).
      expect(mockLoadLifecycleContext).not.toHaveBeenCalled();
      expect(mockExecuteLifecyclePlan).not.toHaveBeenCalled();
      // But it WAS scheduled.
      expect(afterCallbacks.length).toBe(1);

      await flushAfterCallbacks();

      // Now the dispatcher actually executed.
      expect(mockLoadLifecycleContext).toHaveBeenCalledWith("biz_pd");
    });

    it("schedules autoCancelOnPaymentFailure via after() on invoice.payment_failed for active subs", async () => {
      mockLoadLifecycleContext.mockResolvedValue({
        ok: true,
        context: {
          subscription: { id: "sub_row_invfail", status: "active", customer_profile_id: null },
          profile: null,
          now: new Date(),
          vpsHost: null
        },
        vpsHost: null
      } as never);
      vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
        id: "local_sub_invfail",
        business_id: "biz_invfail",
        status: "active",
        stripe_subscription_id: "sub_invfail"
      } as never);
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_invfail",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_invfail",
            // Match the post-2024 Stripe invoice shape that the route's
            // `getInvoiceSubscriptionId` helper reads.
            parent: {
              subscription_details: { subscription: "sub_invfail" }
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
      expect(mockLoadLifecycleContext).not.toHaveBeenCalled();
      expect(afterCallbacks.length).toBe(1);

      await flushAfterCallbacks();

      expect(mockLoadLifecycleContext).toHaveBeenCalledWith("biz_invfail");
    });

    it("schedules runChangePlanFromCheckout via after() on lifecycleAction=changePlan", async () => {
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_changeplan",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_changeplan",
            metadata: {
              businessId: "biz_changeplan",
              lifecycleAction: "changePlan",
              tier: "standard",
              billingPeriod: "annual"
            },
            customer: "cus_changeplan",
            subscription: "sub_changeplan_new"
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
      // Orchestrator must NOT have run synchronously.
      expect(mockRunChangePlanFromCheckout).not.toHaveBeenCalled();
      expect(afterCallbacks.length).toBe(1);

      await flushAfterCallbacks();

      expect(mockRunChangePlanFromCheckout).toHaveBeenCalledTimes(1);
      expect(mockRunChangePlanFromCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cs_changeplan" }),
        "evt_changeplan"
      );
    });

    it("schedules runResubscribeFromCheckout via after() on lifecycleAction=resubscribe", async () => {
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_resub",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_resub",
            metadata: {
              businessId: "biz_resub",
              lifecycleAction: "resubscribe",
              tier: "starter",
              billingPeriod: "annual"
            },
            customer: "cus_resub",
            subscription: "sub_resub_new"
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
      expect(mockRunResubscribeFromCheckout).not.toHaveBeenCalled();
      expect(afterCallbacks.length).toBe(1);

      await flushAfterCallbacks();

      expect(mockRunResubscribeFromCheckout).toHaveBeenCalledTimes(1);
      expect(mockRunResubscribeFromCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cs_resub" }),
        "evt_resub"
      );
    });

    it("logs but does not throw when the orchestrator scheduled via after() rejects", async () => {
      // Defense-in-depth: the orchestrators are documented to swallow
      // their own errors, but the `after()` wrapper has its own
      // try/catch in case that contract regresses. A rejected
      // orchestrator must NOT surface an unhandled rejection from the
      // serverless function (which would taint Vercel's function logs
      // and could in some runtimes crash subsequent invocations on the
      // same warm instance).
      mockRunResubscribeFromCheckout.mockRejectedValueOnce(
        new Error("orchestrator boom")
      );
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_resub_throws",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_resub_throws",
            metadata: {
              businessId: "biz_resub_throws",
              lifecycleAction: "resubscribe",
              tier: "starter",
              billingPeriod: "annual"
            },
            customer: "cus_resub_throws",
            subscription: "sub_resub_throws"
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

      await expect(flushAfterCallbacks()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        "resubscribe orchestrator failed (background)",
        expect.objectContaining({
          sessionId: "cs_resub_throws",
          eventId: "evt_resub_throws",
          error: "orchestrator boom"
        })
      );
    });
  });

  it("short-circuits customer.subscription.deleted fallback for already-finalized upgrade_switch rows", async () => {
    // Late or replayed delivery: the change-plan orchestrator has already
    // stamped the old row (status=canceled, cancel_reason=upgrade_switch) at
    // its step 8. The fallback mirror would otherwise race the orchestrator's
    // own write and re-stamp `stripe_subscription_cached_at`, so we skip it.
    //
    // NOTE: this is NOT the common case. The orchestrator cancels in Stripe at
    // step 6 and stamps the row at step 8, so the webhook usually arrives
    // while the row still looks active. That case is covered by
    // "treats a plan change as a switch even before the orchestrator stamps
    // the row" below, and is why the check also reads the replacement row.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "old_change_sub",
      business_id: "biz_change",
      status: "canceled",
      cancel_reason: "upgrade_switch",
      cancel_at_period_end: false,
      grace_ends_at: null,
      canceled_at: "2026-04-24T00:00:00.000Z"
    } as never);
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_deleted_old_change_sub",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_old_change",
          metadata: { businessId: "biz_change" }
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
    expect(logger.info).toHaveBeenCalledWith(
      "customer.subscription.deleted: skipping fallback mirror for a plan change",
      expect.objectContaining({
        businessId: "biz_change",
        subscriptionId: "old_change_sub"
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
    await flushAfterCallbacks();
    expect(orchestrateProvisioning).toHaveBeenCalledWith({
      businessId: "biz_4",
      tier: "standard",
      vpsSize: null,
      billingPeriod: "biennial",
      notifyOpsNewSignup: true
    });
  });
});

describe("stripe webhook route: voice bonus refund / dispute handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceBonusRpc.mockClear();
    mockCheckoutSessionsList.mockReset();
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

  it("does NOT void a MANUAL pack grant on dispute.created", async () => {
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
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
    // Manual packs stay non-refundable on dispute. Auto-reload charges are
    // the deliberate exception (they are merchant-initiated) and are covered
    // in tests/worker-integration/auto-reload-sweep.itest.ts.
    expect(logger.info).toHaveBeenCalledWith(
      "Stripe dispute created",
      expect.objectContaining({ disputeId: "dp_created_1", autoReloadClawedBack: false })
    );
  });

  it("does not void pack grants on dispute.lost (packs are non-refundable to customers)", async () => {
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
    expect(mockCheckoutSessionsList).not.toHaveBeenCalled();
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Usage pack dispute ignored; packs are non-refundable to customers",
      expect.objectContaining({ eventId: "evt_dispute_lost", type: "charge.dispute.closed" })
    );
  });

  it("does not void pack grants on charge.refunded without New Coworker metadata", async () => {
    mockRefundsList.mockResolvedValueOnce({ data: [{ id: "re_1", metadata: {} }] });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_1",
          amount_refunded: 500,
          payment_intent: "pi_refund_1",
          invoice: "in_refund_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockVoiceBonusRpc).not.toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.anything()
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Usage pack refund ignored; no New Coworker refund metadata",
      expect.objectContaining({ eventId: "evt_refund_1", chargeId: "ch_refund_1" })
    );
  });

  it("voids membership pack grants on charge.refunded with New Coworker metadata", async () => {
    mockRefundsList.mockResolvedValueOnce({
      data: [{ id: "re_nc", metadata: { newcoworker_reason: "thirty_day_money_back" } }]
    });
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_refund_1",
      parent: { subscription_details: { subscription: "sub_live" } }
    });
    mockStripeRetrieve.mockResolvedValueOnce({
      id: "sub_live",
      metadata: { addonVoice: "min_30:1:1800" }
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_refund_nc",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_nc",
          amount_refunded: 5000,
          invoice: "in_refund_1"
        }
      }
    } as never);

    const res = await postEvent();
    expect(res.status).toBe(200);
    expect(mockVoiceBonusRpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_refund_1:voice:min_30",
        p_reason: "refund"
      })
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

  it("parseSmsBonusTextsFromMetadata accepts digits within the hard max and rejects junk", () => {
    expect(parseSmsBonusTextsFromMetadata("500")).toBe(500);
    expect(parseSmsBonusTextsFromMetadata("1000000")).toBe(1000000);
    expect(parseSmsBonusTextsFromMetadata(null)).toBeNull();
    expect(parseSmsBonusTextsFromMetadata(undefined)).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("0")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("-1")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("1.5")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("1e3")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("0x10")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("1000001")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("99999999")).toBeNull();
  });

  it("parseChatCreditMicrosFromMetadata accepts digits within the hard max and rejects junk", () => {
    expect(parseChatCreditMicrosFromMetadata("5000000")).toBe(5_000_000);
    expect(parseChatCreditMicrosFromMetadata("1000000000")).toBe(1_000_000_000);
    expect(parseChatCreditMicrosFromMetadata(null)).toBeNull();
    expect(parseChatCreditMicrosFromMetadata(undefined)).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("0")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("-1")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("0.5")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("1e6")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("1000000001")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("99999999999")).toBeNull();
  });
});

/**
 * Priority support is the tenant's SECOND Stripe subscription on the same
 * customer, which is a shape this repo had never had before. These are the
 * regressions that shape can cause: every one of them is the webhook
 * confusing the add-on for the membership, or vice versa.
 */
describe("stripe webhook route: priority support add-on", () => {
  const PRIORITY_META = { subscriptionKind: "priority_support", businessId: "biz_ps" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeRetrieve.mockResolvedValue({
      id: "sub_priority",
      metadata: PRIORITY_META,
      cancel_at_period_end: false,
      current_period_end: 1702678400
    });
  });

  async function fire() {
    return POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
  }

  it("a paid priority-support invoice NEVER rewrites the membership billing period", async () => {
    // The trap: invoice.paid resolves an unrecognized subscription by its
    // `businessId` metadata and then writes the period cache onto whatever it
    // found. Without the subscriptionKind gate, this invoice would land on the
    // MEMBERSHIP row and overwrite a 12/24-month period with a one-month
    // window, silently re-anchoring the usage quota windows, the renewal date,
    // isCommitmentElapsed, and the contract-term nudge.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_invoice",
      type: "invoice.paid",
      data: {
        object: { parent: { subscription_details: { subscription: "sub_priority" } } }
      }
    } as never);
    // No local row for this Stripe id, which is what sends the handler into
    // the businessId fallback.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "membership_row",
      business_id: "biz_ps",
      status: "active"
    } as never);

    const response = await fire();

    expect(response.status).toBe(200);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(applyPrioritySupportInvoicePaid).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_ps" })
    );
  });

  it("a MEMBERSHIP invoice still updates the membership period", async () => {
    // The other half of the gate: ordinary membership invoices must keep
    // working exactly as before.
    mockStripeRetrieve.mockResolvedValue({
      id: "sub_membership",
      metadata: { businessId: "biz_ps" },
      current_period_start: 1700000000,
      current_period_end: 1702678400
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_membership_invoice",
      type: "invoice.paid",
      data: {
        object: { parent: { subscription_details: { subscription: "sub_membership" } } }
      }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "membership_row"
    } as never);

    await fire();

    expect(updateSubscription).toHaveBeenCalledWith(
      "membership_row",
      expect.objectContaining({ status: "active" })
    );
    expect(applyPrioritySupportInvoicePaid).not.toHaveBeenCalled();
  });

  it("skips a paid priority invoice with no businessId rather than guessing", async () => {
    mockStripeRetrieve.mockResolvedValue({
      id: "sub_priority",
      metadata: { subscriptionKind: "priority_support" },
      current_period_end: 1702678400
    });
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_no_biz",
      type: "invoice.paid",
      data: {
        object: { parent: { subscription_details: { subscription: "sub_priority" } } }
      }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null as never);

    expect((await fire()).status).toBe(200);
    expect(applyPrioritySupportInvoicePaid).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("never fails the webhook when coverage bookkeeping throws", async () => {
    // Failing here would make Stripe retry the whole event; the next paid
    // invoice re-stamps from the live period end anyway.
    vi.mocked(applyPrioritySupportInvoicePaid).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_invoice_err",
      type: "invoice.paid",
      data: {
        object: { parent: { subscription_details: { subscription: "sub_priority" } } }
      }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null as never);

    expect((await fire()).status).toBe(200);
  });

  it("a priority-support checkout records the add-on and does NOT run signup activation", async () => {
    // mode=subscription would otherwise fall through to the default membership
    // activation and adopt this as the tenant's plan subscription.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_ps_1",
          mode: "subscription",
          subscription: "sub_priority",
          customer: "cus_1",
          customer_details: { email: "owner@test.com" },
          metadata: { checkoutKind: "priority_support", businessId: "biz_ps", userId: "user-1" }
        }
      }
    } as never);

    const response = await fire();

    expect(response.status).toBe(200);
    expect(recordPrioritySupportCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_ps",
        stripeSubscriptionId: "sub_priority",
        stripeCustomerId: "cus_1",
        stripeSessionId: "cs_ps_1"
      })
    );
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(ensureCommitmentSchedule).not.toHaveBeenCalled();
  });

  it("still records the add-on when the subscription retrieve fails", async () => {
    // The row must exist even without a period end; the next invoice.paid
    // stamps coverage from the live period.
    mockStripeRetrieve.mockRejectedValueOnce(new Error("stripe down"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_checkout_retrieve_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_ps_2",
          mode: "subscription",
          subscription: "sub_priority",
          customer: "cus_1",
          metadata: { checkoutKind: "priority_support", businessId: "biz_ps" }
        }
      }
    } as never);

    expect((await fire()).status).toBe(200);
    expect(recordPrioritySupportCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ periodEnd: null })
    );
  });

  it("skips a priority-support checkout with no businessId or no subscription", async () => {
    for (const object of [
      {
        id: "cs_ps_3",
        mode: "subscription",
        subscription: "sub_priority",
        metadata: { checkoutKind: "priority_support" }
      },
      {
        id: "cs_ps_4",
        mode: "subscription",
        metadata: { checkoutKind: "priority_support", businessId: "biz_ps" }
      }
    ]) {
      vi.clearAllMocks();
      vi.mocked(verifyWebhook).mockReturnValue({
        id: "evt_ps_bad",
        type: "checkout.session.completed",
        data: { object }
      } as never);
      expect((await fire()).status).toBe(200);
      expect(recordPrioritySupportCheckout).not.toHaveBeenCalled();
    }
  });

  it("mirrors add-on status on customer.subscription.updated without touching the membership", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_priority",
          status: "active",
          cancel_at_period_end: true,
          current_period_end: 1702678400,
          metadata: PRIORITY_META
        }
      }
    } as never);

    expect((await fire()).status).toBe(200);
    expect(mirrorPrioritySupportSubscription).toHaveBeenCalledWith(
      "sub_priority",
      expect.objectContaining({ status: "canceling", cancelAtPeriodEnd: true })
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("mirrors a canceled add-on status", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_updated_canceled",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_priority",
          status: "canceled",
          cancel_at_period_end: false,
          current_period_end: 1702678400,
          metadata: PRIORITY_META
        }
      }
    } as never);

    expect((await fire()).status).toBe(200);
    expect(mirrorPrioritySupportSubscription).toHaveBeenCalledWith(
      "sub_priority",
      expect.objectContaining({ status: "canceled" })
    );
  });

  it("survives a mirror failure without failing the webhook", async () => {
    vi.mocked(mirrorPrioritySupportSubscription).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_updated_err",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_priority",
          status: "active",
          cancel_at_period_end: false,
          metadata: PRIORITY_META
        }
      }
    } as never);
    expect((await fire()).status).toBe(200);
  });

  it("deleting the ADD-ON never tears the tenant down", async () => {
    // It is only an add-on ending: no auto-reload disable, no grace window,
    // no VM stop.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_priority", metadata: PRIORITY_META } }
    } as never);

    expect((await fire()).status).toBe(200);
    expect(markPrioritySupportSubscriptionCanceled).toHaveBeenCalledWith(
      "sub_priority",
      expect.any(Date)
    );
    expect(getSubscriptionByStripeSubscriptionId).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("survives a cancel-mirror failure without failing the webhook", async () => {
    vi.mocked(markPrioritySupportSubscriptionCanceled).mockRejectedValueOnce(
      new Error("db down")
    );
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_ps_deleted_err",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_priority", metadata: PRIORITY_META } }
    } as never);
    expect((await fire()).status).toBe(200);
  });

  it("cancels the add-on when the MEMBERSHIP is torn down", async () => {
    // A separate Stripe subscription keeps charging $400/month otherwise.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_membership_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_membership", metadata: { businessId: "biz_ps" } } }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "membership_row",
      business_id: "biz_ps",
      status: "active",
      cancel_at_period_end: false,
      grace_ends_at: null,
      wiped_at: null
    } as never);

    await fire();

    expect(terminatePrioritySupport).toHaveBeenCalledWith("biz_ps");
  });

  it("does NOT cancel the add-on on an upgrade switch", async () => {
    // A plan change cancels the OLD Stripe subscription and builds a new one,
    // delivering this same event for a tenant who is still very much active.
    // Cancelling their priority support here would silently drop a paid add-on
    // every time somebody upgrades.
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_upgrade_switch_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_old", metadata: { businessId: "biz_ps" } } }
    } as never);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      id: "old_membership_row",
      business_id: "biz_ps",
      status: "canceled",
      cancel_reason: "upgrade_switch",
      cancel_at_period_end: false,
      grace_ends_at: null,
      wiped_at: null
    } as never);

    await fire();

    expect(terminatePrioritySupport).not.toHaveBeenCalled();
  });
});

/**
 * A plan change cancels the OLD Stripe subscription and builds a new one, so
 * `customer.subscription.deleted` fires for a tenant who is still active. The
 * orchestrator cancels in Stripe at step 6 and only stamps the old row
 * `upgrade_switch` at step 8, with the slow box teardown in between, so the
 * webhook normally lands while the row still looks active. Anything in that
 * handler that tears down tenant state has to survive that window.
 */
describe("stripe webhook route: plan change vs real cancellation", () => {
  const DELETED = {
    id: "evt_old_sub_deleted",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_old", metadata: { businessId: "biz_switch" } } }
  };

  const OLD_ROW_MID_ORCHESTRATION = {
    id: "old_row",
    business_id: "biz_switch",
    // Step 8 has NOT run yet: the row still looks completely live.
    status: "active",
    cancel_reason: null,
    cancel_at_period_end: false,
    grace_ends_at: null,
    wiped_at: null,
    canceled_at: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSubscription).mockResolvedValue(null as never);
    vi.mocked(verifyWebhook).mockReturnValue(DELETED as never);
  });

  async function fire() {
    return POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );
  }

  it("does NOT disable auto-reload on a plan change, even before the row is stamped", async () => {
    // The bug: `disableAutoReloadForBusiness` fired unconditionally, and
    // nothing ever re-enables those rules, so every upgrade or downgrade
    // silently stopped the tenant's top-ups.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(
      OLD_ROW_MID_ORCHESTRATION as never
    );
    // Step 5 already created the replacement, which is the signal that works
    // regardless of how steps 6 and 8 interleave with webhook delivery.
    vi.mocked(getSubscription).mockResolvedValue({
      id: "new_row",
      business_id: "biz_switch",
      status: "active",
      stripe_subscription_id: "sub_new"
    } as never);

    const response = await fire();

    expect(response.status).toBe(200);
    expect(mockDisableAutoReloadForBusiness).not.toHaveBeenCalled();
    expect(terminatePrioritySupport).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("DOES disable auto-reload on a real cancellation", async () => {
    // The newest row is the one being deleted, so there is no replacement and
    // the tenant really is leaving.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue({
      ...OLD_ROW_MID_ORCHESTRATION,
      status: "canceled",
      cancel_reason: "customer_request"
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "old_row",
      business_id: "biz_switch",
      status: "canceled",
      stripe_subscription_id: "sub_old"
    } as never);

    await fire();

    expect(mockDisableAutoReloadForBusiness).toHaveBeenCalledWith(
      "biz_switch",
      "subscription_canceled"
    );
    expect(terminatePrioritySupport).toHaveBeenCalledWith("biz_switch");
  });

  it("treats a plan change as a switch even before the orchestrator stamps the row", async () => {
    // Same window as the auto-reload case, asserted on the fallback mirror:
    // the old row must not be re-stamped or given a grace deadline.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(
      OLD_ROW_MID_ORCHESTRATION as never
    );
    vi.mocked(getSubscription).mockResolvedValue({
      id: "new_row",
      business_id: "biz_switch",
      status: "active",
      stripe_subscription_id: "sub_new"
    } as never);

    await fire();

    expect(updateSubscription).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "customer.subscription.deleted: plan change, skipping tenant teardown",
      expect.objectContaining({ businessId: "biz_switch" })
    );
  });

  it("still disables auto-reload when the replacement never became active", async () => {
    // A change-plan that failed before step 5, or a signup row stuck pending:
    // no live replacement, so this is a real teardown.
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(
      OLD_ROW_MID_ORCHESTRATION as never
    );
    vi.mocked(getSubscription).mockResolvedValue({
      id: "new_row",
      business_id: "biz_switch",
      status: "pending",
      stripe_subscription_id: "sub_new"
    } as never);

    await fire();

    expect(mockDisableAutoReloadForBusiness).toHaveBeenCalled();
  });

  it("keeps the teardown non-fatal when the auto-reload disable throws", async () => {
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(
      OLD_ROW_MID_ORCHESTRATION as never
    );
    vi.mocked(getSubscription).mockResolvedValue(null as never);
    mockDisableAutoReloadForBusiness.mockRejectedValueOnce(new Error("rpc down"));

    expect((await fire()).status).toBe(200);
    expect(terminatePrioritySupport).toHaveBeenCalled();
  });
});
