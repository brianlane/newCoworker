import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionRow } from "@/lib/db/subscriptions";

const {
  loadLifecycleContextMock,
  executeFastMock,
  executeSlowMock,
  updateSubscriptionMock,
  getBusinessMock,
  sendOwnerEmailMock,
  sendOpsCanceledMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerErrorMock
} = vi.hoisted(() => ({
  loadLifecycleContextMock: vi.fn(),
  executeFastMock: vi.fn(),
  executeSlowMock: vi.fn(),
  updateSubscriptionMock: vi.fn(),
  getBusinessMock: vi.fn(),
  sendOwnerEmailMock: vi.fn(),
  sendOpsCanceledMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: loadLifecycleContextMock
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlanFastPhase: executeFastMock,
  executeLifecyclePlanSlowPhase: executeSlowMock
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return { ...actual, updateSubscription: updateSubscriptionMock };
});

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: getBusinessMock
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: sendOwnerEmailMock
}));

vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsSubscriptionCanceledEmail: sendOpsCanceledMock
}));

vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn().mockResolvedValue("en")
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

vi.mock("next/server", () => ({
  after: async (cb: () => void | Promise<void>) => {
    await cb();
  }
}));

import {
  dispatchExternalStripeCancel,
  stripeCancellationDetailsLabel
} from "@/lib/billing/external-stripe-cancel";

function makeSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    business_id: "biz-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_stripe_1",
    membership_pack_addons: null,
    discount_coupon_id: null,
    discount_name: null,
    discount_percent_off: null,
    discount_amount_off_cents: null,
    discount_duration: null,
    discount_duration_in_months: null,
    discount_started_at: null,
    discount_ends_at: null,
    tier: "starter",
    status: "active",
    billing_period: "monthly",
    renewal_at: null,
    commitment_months: 1,
    stripe_current_period_start: "2026-04-01T00:00:00.000Z",
    stripe_current_period_end: "2026-05-01T00:00:00.000Z",
    stripe_subscription_cached_at: "2026-04-10T00:00:00.000Z",
    customer_profile_id: "prof-1",
    canceled_at: null,
    cancel_reason: null,
    grace_ends_at: null,
    wiped_at: null,
    vps_stopped_at: null,
    hostinger_billing_subscription_id: "hbs-1",
    cancel_at_period_end: false,
    contract_auto_renew: false,
    billing_paused: false,
    billing_pause_resumes_at: null,
    stripe_refund_id: null,
    refund_amount_cents: null,
    monthly_intro_nudge_sent_at: null,
    monthly_intro_ends_at: null,
    contract_term_nudge_sent_at: null,
    created_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  };
}

const NOW = new Date("2026-09-17T01:04:59.000Z");

describe("stripeCancellationDetailsLabel", () => {
  it("joins reason, feedback, and comment when present", () => {
    expect(stripeCancellationDetailsLabel({})).toBeNull();
    expect(stripeCancellationDetailsLabel({ cancellation_details: null })).toBeNull();
    expect(
      stripeCancellationDetailsLabel({
        cancellation_details: { reason: "  ", feedback: null, comment: "" }
      })
    ).toBeNull();
    expect(
      stripeCancellationDetailsLabel({
        cancellation_details: {
          reason: "cancellation_requested",
          feedback: "too_expensive",
          comment: "switching tools"
        }
      })
    ).toBe("cancellation_requested / too_expensive / switching tools");
  });
});

describe("dispatchExternalStripeCancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    executeFastMock.mockResolvedValue({ ok: true });
    executeSlowMock.mockResolvedValue(undefined);
    updateSubscriptionMock.mockResolvedValue(undefined);
    sendOwnerEmailMock.mockResolvedValue(undefined);
    sendOpsCanceledMock.mockResolvedValue(true);
    getBusinessMock.mockResolvedValue({
      name: "Scar Fairy",
      owner_name: "Selena",
      owner_email: "selena@example.com",
      timezone: "America/Phoenix"
    });
  });

  it("skips rows that already have an in-app or admin cancel reason", async () => {
    const dispatched = await dispatchExternalStripeCancel({
      existing: makeSub({ cancel_reason: "user_refund" }),
      eventId: "evt_1",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null
    });
    expect(dispatched).toBe("skipped");
    expect(loadLifecycleContextMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it("runs lifecycle when the row is still active", async () => {
    const existing = makeSub();
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: "1.2.3.4",
      context: {
        subscription: existing,
        ownerEmail: "selena@example.com",
        ownerName: "Selena",
        businessName: "Scar Fairy",
        profile: null,
        virtualMachineId: 42,
        vpsHost: "1.2.3.4",
        now: NOW
      }
    });
    const after = vi.fn(async (cb: () => Promise<void>) => {
      await cb();
    });
    const dispatched = await dispatchExternalStripeCancel({
      existing,
      eventId: "evt_portal",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: "cancellation_requested",
      now: NOW,
      after
    });
    expect(dispatched).toBe("lifecycle");
    expect(executeFastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeOps: [],
        emailsToSend: expect.arrayContaining([
          expect.objectContaining({
            type: "send_cancel_confirmation",
            reason: "stripe_external"
          }),
          expect.objectContaining({
            type: "send_ops_subscription_canceled",
            cancelReason: "stripe_external"
          })
        ])
      }),
      expect.objectContaining({ businessId: "biz-1", vpsHost: "1.2.3.4" })
    );
    expect(after).toHaveBeenCalledTimes(1);
    expect(executeSlowMock).toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it("logs a slow-phase Error and a non-Error without failing the dispatch", async () => {
    const existing = makeSub();
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: null,
      context: {
        subscription: existing,
        ownerEmail: "selena@example.com",
        profile: null,
        virtualMachineId: null,
        vpsHost: null,
        now: NOW
      }
    });
    executeSlowMock.mockRejectedValueOnce(new Error("ssh down"));
    await dispatchExternalStripeCancel({
      existing,
      eventId: "evt_slow_err",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "externalStripeCancel slow phase failed (background)",
      expect.objectContaining({ error: "ssh down" })
    );

    executeSlowMock.mockRejectedValueOnce("string boom");
    await dispatchExternalStripeCancel({
      existing,
      eventId: "evt_slow_str",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "externalStripeCancel slow phase failed (background)",
      expect.objectContaining({ error: "string boom" })
    );
  });

  it("falls back to notify-only when the planner rejects the loaded context", async () => {
    loadLifecycleContextMock.mockResolvedValue({
      ok: true,
      vpsHost: null,
      context: {
        subscription: makeSub({ status: "canceled" }),
        ownerEmail: "selena@example.com",
        profile: null,
        virtualMachineId: null,
        vpsHost: null,
        now: NOW
      }
    });
    const dispatched = await dispatchExternalStripeCancel({
      existing: makeSub({ status: "active" }),
      eventId: "evt_plan_reject",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(dispatched).toBe("notify_only");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "externalStripeCancel planner rejected; falling back to notify-only",
      expect.objectContaining({ reason: "subscription_not_active" })
    );
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-1",
      expect.objectContaining({ cancel_reason: "stripe_external", status: "canceled" })
    );
  });

  it("falls back to notify-only when context load fails or returns nothing", async () => {
    loadLifecycleContextMock.mockResolvedValueOnce({
      ok: false,
      reason: "subscription_not_found"
    });
    await expect(
      dispatchExternalStripeCancel({
        existing: makeSub(),
        eventId: "evt_load_fail",
        stripeSubscriptionId: "sub_stripe_1",
        cancellationDetails: null,
        now: NOW
      })
    ).resolves.toBe("notify_only");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "externalStripeCancel context load failed; falling back to notify-only",
      expect.objectContaining({ reason: "subscription_not_found" })
    );

    loadLifecycleContextMock.mockResolvedValueOnce(undefined);
    await expect(
      dispatchExternalStripeCancel({
        existing: makeSub(),
        eventId: "evt_load_undef",
        stripeSubscriptionId: "sub_stripe_1",
        cancellationDetails: null,
        now: NOW
      })
    ).resolves.toBe("notify_only");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "externalStripeCancel context load failed; falling back to notify-only",
      expect.objectContaining({ reason: "context_unavailable" })
    );
  });

  it("skips a second notify when the row is already stripe_external", async () => {
    const dispatched = await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled", cancel_reason: "stripe_external" }),
      eventId: "evt_dup",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(dispatched).toBe("skipped");
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it("stamps stripe_external and emails owner plus ops for a canceled null-reason row", async () => {
    const existing = makeSub({
      status: "canceled",
      cancel_reason: null,
      canceled_at: "2026-09-17T01:04:59.000Z",
      grace_ends_at: "2026-10-17T01:04:59.000Z"
    });
    const dispatched = await dispatchExternalStripeCancel({
      existing,
      eventId: "evt_scar",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: "cancellation_requested",
      now: NOW
    });
    expect(dispatched).toBe("notify_only");
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-1",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: "stripe_external",
        cancel_at_period_end: false,
        grace_ends_at: "2026-10-17T01:04:59.000Z",
        canceled_at: "2026-09-17T01:04:59.000Z"
      })
    );
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "selena@example.com",
      expect.stringMatching(/canceled/i),
      expect.objectContaining({
        text: expect.stringContaining("You keep through the data-retention window")
      })
    );
    expect(sendOpsCanceledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        businessName: "Scar Fairy",
        ownerName: "Selena",
        ownerEmail: "selena@example.com",
        cancelReason: "stripe_external",
        cancelPath: "stripe_external",
        stripeCancellationDetails: "cancellation_requested"
      })
    );
  });

  it("schedules grace when none is stamped, and leaves it null when already wiped", async () => {
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled", cancel_reason: null, grace_ends_at: null }),
      eventId: "evt_grace",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-1",
      expect.objectContaining({
        grace_ends_at: "2026-10-17T01:04:59.000Z",
        canceled_at: NOW.toISOString()
      })
    );

    updateSubscriptionMock.mockClear();
    await dispatchExternalStripeCancel({
      existing: makeSub({
        status: "canceled",
        cancel_reason: null,
        grace_ends_at: null,
        wiped_at: "2026-09-17T01:04:59.000Z"
      }),
      eventId: "evt_wiped",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub-1",
      expect.objectContaining({ grace_ends_at: null })
    );
  });

  it("skips the owner email without a Resend key, and still pages ops", async () => {
    delete process.env.RESEND_API_KEY;
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled" }),
      eventId: "evt_nokey",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "owner cancel-confirmation skipped on stripe_external: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1" })
    );
    expect(sendOpsCanceledMock).toHaveBeenCalled();
  });

  it("skips the owner email when the business has no owner address", async () => {
    getBusinessMock.mockResolvedValueOnce({
      name: "",
      owner_name: null,
      owner_email: null
    });
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled" }),
      eventId: "evt_noowner",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(sendOpsCanceledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: "",
        ownerName: null,
        ownerEmail: "(none on file)"
      })
    );
  });

  it("swallows owner-email send failures (Error and non-Error)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled" }),
      eventId: "evt_mail_err",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "owner cancel-confirmation email failed on stripe_external notify-only",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("string fail");
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled" }),
      eventId: "evt_mail_str",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "owner cancel-confirmation email failed on stripe_external notify-only",
      expect.objectContaining({ error: "string fail" })
    );
    expect(sendOpsCanceledMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to localhost site URL and a missing business row", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    getBusinessMock.mockResolvedValueOnce(null);
    await dispatchExternalStripeCancel({
      existing: makeSub({ status: "canceled" }),
      eventId: "evt_nobiz",
      stripeSubscriptionId: "sub_stripe_1",
      cancellationDetails: null,
      now: NOW
    });
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(sendOpsCanceledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: "",
        ownerEmail: "(none on file)"
      })
    );
  });
});
