import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeLifecyclePlan,
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase,
  type ExecutorDeps
} from "@/lib/billing/lifecycle-executor";
import type { LifecyclePlan } from "@/lib/billing/lifecycle";
import { HostingerApiError } from "@/lib/hostinger/client";
import { TelnyxApiError, type TelnyxNumbersClient } from "@/lib/telnyx/numbers";

const {
  updateSubscriptionMock,
  markRefundUsedMock,
  recordSubscriptionRefundMock,
  sendOwnerEmailMock,
  updateBusinessStatusMock,
  backupBusinessDataMock,
  deleteBusinessBackupMock,
  createSupabaseServiceClientMock,
  releaseVpsToPoolMock,
  deleteTelnyxVoiceRouteMock,
  upsertBusinessTelnyxSettingsMock,
  sendOpsDidReleaseFailedEmailMock,
  revokeNangoConnectionsForBusinessMock
} = vi.hoisted(() => ({
  updateSubscriptionMock: vi.fn(),
  markRefundUsedMock: vi.fn(),
  recordSubscriptionRefundMock: vi.fn(),
  sendOwnerEmailMock: vi.fn(),
  updateBusinessStatusMock: vi.fn(),
  backupBusinessDataMock: vi.fn(),
  deleteBusinessBackupMock: vi.fn(),
  createSupabaseServiceClientMock: vi.fn(),
  releaseVpsToPoolMock: vi.fn(),
  deleteTelnyxVoiceRouteMock: vi.fn(),
  upsertBusinessTelnyxSettingsMock: vi.fn(),
  sendOpsDidReleaseFailedEmailMock: vi.fn(),
  revokeNangoConnectionsForBusinessMock: vi.fn()
}));

vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsDidReleaseFailedEmail: sendOpsDidReleaseFailedEmailMock
}));

vi.mock("@/lib/db/telnyx-routes", () => ({
  deleteTelnyxVoiceRoute: deleteTelnyxVoiceRouteMock,
  upsertBusinessTelnyxSettings: upsertBusinessTelnyxSettingsMock
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

vi.mock("@/lib/nango/cleanup", () => ({
  revokeNangoConnectionsForBusiness: revokeNangoConnectionsForBusinessMock
}));

// Keep the module's PURE selectors real and only stub the DB write: the
// pool-return op resolves a paid-through through `paidThroughFromBillingSub`,
// and a factory that dropped it silently turned every resolve into null (the
// helper catches the resulting TypeError and reports "unknown expiry").
vi.mock("@/lib/db/vps-inventory", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/vps-inventory")>()),
  releaseVpsToPool: releaseVpsToPoolMock
}));

vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: backupBusinessDataMock,
  deleteBusinessBackup: deleteBusinessBackupMock
}));

const { wipeByosBoxMock } = vi.hoisted(() => ({ wipeByosBoxMock: vi.fn() }));
vi.mock("@/lib/provisioning/byos-wipe", () => ({
  wipeByosBox: wipeByosBoxMock
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

function refundPlan(amountCents = 2500, usageCarveOutCents = 0): LifecyclePlan {
  return {
    stripeOps: [
      {
        type: "refund_latest_charge",
        stripeSubscriptionId: "sub_123",
        reason: "thirty_day_money_back",
        usageCarveOutCents
      }
    ],
    hostingerOps: [],
    sshOps: [],
    telnyxOps: [],
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
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
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
      expect.objectContaining({
        text: expect.stringContaining("$25.00"),
        html: expect.stringContaining("$25.00")
      })
    );
  });

  it("claws back membership pack grants after a New Coworker refund", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_pack",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_pack",
          amount_paid: 2500,
          payments: { data: [{ payment: { payment_intent: "pi_pack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_pack", latest_charge: "ch_pack" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_pack" }) }
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
      rpc,
      from: undefined
    });

    await executeLifecyclePlan(
      refundPlan(),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(rpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_pack:voice:min_30",
        p_reason: "refund"
      })
    );
  });

  it("claws back packs with admin reason on admin_force refunds", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_admin",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_admin",
          amount_paid: 2500,
          payments: { data: [{ payment: { payment_intent: "pi_admin" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_admin", latest_charge: "ch_admin" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_admin" }) }
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
      rpc,
      from: undefined
    });
    const plan = refundPlan();
    plan.stripeOps[0] = {
      type: "refund_latest_charge",
      stripeSubscriptionId: "sub_123",
      reason: "admin_force",
      usageCarveOutCents: 0
    };

    await executeLifecyclePlan(
      plan,
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(rpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_admin:voice:min_30",
        p_reason: "admin"
      })
    );
  });

  it("logs when pack clawback throws after a successful refund", async () => {
    const { logger } = await import("@/lib/logger");
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_boom",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_boom",
          amount_paid: 2500,
          payments: { data: [{ payment: { payment_intent: "pi_boom" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_boom", latest_charge: "ch_boom" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_boom" }) }
    };
    createSupabaseServiceClientMock.mockRejectedValueOnce("string db down").mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } }
    });

    await executeLifecyclePlan(
      refundPlan(),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "refund_latest_charge: pack clawback failed",
      expect.objectContaining({ invoiceId: "in_boom", error: "string db down" })
    );
  });

  it("claws back packs when Stripe amount paid is zero (no refund create)", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_zero_pack",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_zero_pack",
          amount_paid: 0,
          payments: { data: [{ payment: { payment_intent: "pi_zero_pack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_zero_pack", latest_charge: "ch_zero_pack" })
      },
      refunds: { create: vi.fn() }
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
      rpc,
      from: undefined
    });

    await executeLifecyclePlan(
      refundPlan(0),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_zero_pack:voice:min_30",
        p_reason: "refund"
      })
    );
  });

  it("claws back packs when carve-outs leave nothing to refund", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_carve_pack",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_carve_pack",
          amount_paid: 2500,
          lines: { data: [] },
          payments: { data: [{ payment: { payment_intent: "pi_carve_pack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          id: "pi_carve_pack",
          latest_charge: "ch_carve_pack"
        })
      },
      refunds: { create: vi.fn() }
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
      rpc,
      from: undefined
    });

    await executeLifecyclePlan(
      refundPlan(2500, 2500),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_carve_pack:voice:min_30",
        p_reason: "refund"
      })
    );
  });

  it("uses localhost base URL for cancel email when NEXT_PUBLIC_APP_URL is unset", async () => {
    const prevPublic = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const send = vi.fn().mockResolvedValue(null);
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
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
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: send }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][3] as { html: string }).html).toContain("http://localhost:3000");
    if (prevPublic === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prevPublic;
  });

  it("strips trailing slash from NEXT_PUBLIC_APP_URL in cancel email HTML", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://trailing.example.com/";
    const send = vi.fn().mockResolvedValue(null);
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
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
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: send }
    );
    const html = (send.mock.calls[0][3] as { html: string }).html;
    expect(html).not.toContain("https://trailing.example.com//");
    expect(html).toContain("https://trailing.example.com/dashboard/billing");
  });

  it("renders the cancel email date in the business timezone", async () => {
    const send = vi.fn().mockResolvedValue(null);
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: "biz_1",
            reason: "user_period_end",
            // Midnight UTC on June 2 is still June 1 in Phoenix (UTC-7).
            effectiveAt: "2026-06-02T05:00:00.000Z",
            graceEndsAt: null,
            timeZone: "America/Phoenix"
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: send }
    );
    const text = (send.mock.calls[0][3] as { text: string }).text;
    expect(text).toContain("June 1, 2026");
    expect(text).not.toContain("June 2, 2026");
  });

  it("uses localhost base URL for refund email when NEXT_PUBLIC_APP_URL is unset", async () => {
    const prevPublic = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
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
    const send = vi.fn().mockResolvedValue(null);
    await executeLifecyclePlan(
      refundPlan(),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: send }
    );
    expect(send).toHaveBeenCalled();
    expect((send.mock.calls[0][3] as { html: string }).html).toContain("http://localhost:3000");
    if (prevPublic === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prevPublic;
  });

  it("strips trailing slash from NEXT_PUBLIC_APP_URL in refund email HTML", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://refund-trailing.example.com/";
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_slash" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_slash",
          amount_paid: 2500,
          payments: {
            data: [{ payment: { payment_intent: "pi_slash" } }]
          }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_slash", latest_charge: "ch_slash" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_slash" }) }
    };
    const send = vi.fn().mockResolvedValue(null);
    await executeLifecyclePlan(
      refundPlan(),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: send }
    );
    const html = (send.mock.calls[0][3] as { html: string }).html;
    expect(html).not.toContain("https://refund-trailing.example.com//");
    expect(html).toContain("https://refund-trailing.example.com/dashboard/billing");
  });

  it("carves the non-refundable carrier registration fee out of the refund", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_fee" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_fee",
          amount_paid: 4450,
          lines: {
            data: [
              { description: "1 × Starter (at $25.00 / month)", amount: 2500 },
              { description: "Carrier registration (10DLC)", amount: 1950 },
              // Defensive branches: Stripe types allow null description/amount.
              { description: null, amount: 100 },
              { description: "Carrier registration (10DLC) adjustment", amount: null }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_fee" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_fee", latest_charge: "ch_fee" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_fee" }) }
    };

    await executeLifecyclePlan(
      refundPlan(4450),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    // 4450 paid − 1950 fee = 2500 refunded (the null-amount fee line adds 0).
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_fee", amount: 2500 })
    );
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2500 })
    );
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringMatching(/refund/i),
      expect.objectContaining({ text: expect.stringContaining("$25.00") })
    );
  });

  it("carves out only the POST-discount fee amount when a coupon touched the fee line", async () => {
    // Real-world shape from Truly Insurance's Jul 2026 first invoice: the
    // monthly intro coupon ($84.00) was allocated proportionally by Stripe —
    // $78.52 onto the plan line and $5.48 onto the carrier fee line. The
    // customer effectively paid $19.50 − $5.48 = $14.02 for the fee, so the
    // carve-out must keep $14.02, not $19.50 (which would claw back part of
    // the plan discount they were granted).
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_disc" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_disc",
          amount_paid: 21450, // 27900 + 1950 − 8400 coupon
          lines: {
            data: [
              {
                description: "1 × New Coworker Standard (at $279.00 / month)",
                amount: 27900,
                discount_amounts: [{ amount: 7852, discount: "di_1" }]
              },
              {
                description: "Carrier registration (10DLC)",
                amount: 1950,
                discount_amounts: [{ amount: 548, discount: "di_1" }]
              },
              // Defensive branches: null discount_amounts array and a
              // null-amount entry inside one must both count as 0.
              {
                description: "Carrier registration (10DLC) surcharge",
                amount: 100,
                discount_amounts: null
              },
              {
                description: "Carrier registration (10DLC) adjustment",
                amount: 50,
                discount_amounts: [{ amount: null, discount: "di_1" }]
              },
              // A fee line discounted BELOW zero (e.g. a 100%-off comp
              // coupon plus rounding) must clamp to 0, not go negative.
              {
                description: "Carrier registration (10DLC) comp",
                amount: 25,
                discount_amounts: [{ amount: 60, discount: "di_comp" }]
              }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_disc" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_disc", latest_charge: "ch_disc" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_disc" }) }
    };

    await executeLifecyclePlan(
      refundPlan(21450),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    // Fee carve-out = (1950−548) + (100−0) + (50−0) + max(25−60, 0)
    //               = 1402 + 100 + 50 + 0 = 1552.
    // Refund = 21450 − 1552 = 19898.
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_disc", amount: 19898 })
    );
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 19898 })
    );
  });

  it("carves membership pack add-on lines out of the refund (packs are non-refundable)", async () => {
    const { logger } = await import("@/lib/logger");
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_packs" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_packs",
          amount_paid: 25000,
          lines: {
            data: [
              { description: "1 × New Coworker Starter (at $100.00 / month)", amount: 10000 },
              // Renewal invoices render subscription items with the
              // "1 × ... (at $X / month)" wrapper; the prefix match must
              // still hit. Post-discount: 5700 − 700 = 5000.
              {
                description: "1 × Voice top-up: 30 min (at $57.00 / month)",
                amount: 5700,
                discount_amounts: [{ amount: 700, discount: "di_p" }]
              },
              { description: "SMS top-up: 500 texts", amount: 3000, discount_amounts: null },
              {
                description: "AI chat credit: $20 AI budget",
                amount: 2000,
                discount_amounts: [{ amount: null, discount: "di_p" }]
              },
              // Over-discounted pack line clamps to 0, never negative.
              {
                description: "Voice top-up: 60 min",
                amount: 1000,
                discount_amounts: [{ amount: 1500, discount: "di_comp" }]
              },
              // A negative proration/credit pack line contributes 0 and can
              // never inflate the refund.
              { description: "Voice top-up: 30 min", amount: -500 },
              // Stripe types allow a null amount.
              { description: "SMS top-up: bonus", amount: null }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_packs" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_packs", latest_charge: "ch_packs" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_packs" }) }
    };

    await executeLifecyclePlan(
      refundPlan(25000),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    // Pack carve-out = 5000 + 3000 + 2000 + 0 + 0 + 0 = 10000.
    // Refund = 25000 − 10000 = 15000.
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_packs", amount: 15000 })
    );
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 15000 })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "refund_latest_charge: carving out non-refundable amounts",
      expect.objectContaining({ packCarveOutCents: 10000, refundCents: 15000 })
    );
  });

  it("stacks the pack carve-out with the carrier fee and usage carve-outs", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_stack" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_stack",
          amount_paid: 40000,
          lines: {
            data: [
              { description: "1 × New Coworker Standard (at $279.00 / month)", amount: 32350 },
              { description: "Carrier registration (10DLC)", amount: 1950 },
              { description: "Voice top-up: 30 min", amount: 5700 }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_stack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_stack", latest_charge: "ch_stack" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_stack" }) }
    };

    await executeLifecyclePlan(
      refundPlan(40000, 250),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    // 40000 − 1950 fee − 5700 packs − 250 usage = 32100.
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_stack", amount: 32100 })
    );
  });

  it("still voids grants when the pack carve-out swallows the whole payment", async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          latest_invoice: "in_all_pack",
          metadata: { addonVoice: "min_30:1:1800" }
        })
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_all_pack",
          amount_paid: 5700,
          lines: { data: [{ description: "Voice top-up: 30 min", amount: 5700 }] },
          payments: { data: [{ payment: { payment_intent: "pi_all_pack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_all_pack", latest_charge: "ch_all_pack" })
      },
      refunds: { create: vi.fn() }
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    createSupabaseServiceClientMock.mockResolvedValue({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
      rpc,
      from: undefined
    });

    await executeLifecyclePlan(
      refundPlan(5700),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(recordSubscriptionRefundMock).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "void_voice_bonus_grant_by_checkout_session",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_all_pack:voice:min_30",
        p_reason: "refund"
      })
    );
  });

  it("carves pack lines identically on admin_force refunds", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_adm_pack" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_adm_pack",
          amount_paid: 15700,
          lines: {
            data: [
              { description: "1 × New Coworker Starter (at $100.00 / month)", amount: 10000 },
              { description: "Voice top-up: 30 min", amount: 5700 }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_adm_pack" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_adm_pack", latest_charge: "ch_adm_pack" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_adm_pack" }) }
    };
    const plan = refundPlan(15700);
    plan.stripeOps[0] = {
      type: "refund_latest_charge",
      stripeSubscriptionId: "sub_123",
      reason: "admin_force",
      usageCarveOutCents: 0
    };

    await executeLifecyclePlan(
      plan,
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: "ch_adm_pack",
        amount: 10000,
        metadata: expect.objectContaining({ newcoworker_reason: "admin_force" })
      })
    );
  });

  /**
   * The term deduction was removed in Aug 2026 along with the term box it
   * existed to recover: signups buy MONTHLY hardware now, so a day-2 cancel
   * on a 24-month plan strands at most one month of a monthly box rather
   * than a whole prepaid term.
   */
  it("refunds a term plan in full, less only the carve-outs a monthly refund takes", async () => {
    // Standard biennial: 24 × $99 = $2376 plan + $19.50 fee = $2395.50 paid.
    // Refund = 239550 − 1950 (non-refundable carrier fee) = 237600.
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_term" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_term",
          amount_paid: 239550,
          lines: {
            data: [
              { description: "1 × New Coworker Standard (at $2,376.00 / 24 months)", amount: 237600 },
              { description: "Carrier registration (10DLC)", amount: 1950 }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_term" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_term", latest_charge: "ch_term" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_term" }) }
    };

    await executeLifecyclePlan(
      refundPlan(239550),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_term", amount: 237600 })
    );
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 237600 })
    );
  });

  it("withholds the billable-usage carve-out alongside the fee and term carve-outs", async () => {
    // $2395.50 paid − $19.50 fee − $195 term month − $12.34 usage = $2168.66.
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_usage" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_usage",
          amount_paid: 239550,
          lines: {
            data: [
              { description: "1 × New Coworker Standard (at $2,376.00 / 24 months)", amount: 237600 },
              { description: "Carrier registration (10DLC)", amount: 1950 }
            ]
          },
          payments: { data: [{ payment: { payment_intent: "pi_usage" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_usage", latest_charge: "ch_usage" })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_usage" }) }
    };

    await executeLifecyclePlan(
      refundPlan(239550, 1234),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_usage", amount: 239550 - 1950 - 1234 })
    );
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 236366 })
    );
  });

  it("skips the refund when the usage carve-out alone swallows the amount paid", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_usage_all" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_usage_all",
          amount_paid: 1599,
          lines: { data: [] },
          payments: { data: [{ payment: { payment_intent: "pi_usage_all" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_usage_all", latest_charge: "ch_usage_all" })
      },
      refunds: { create: vi.fn() }
    };

    await executeLifecyclePlan(
      refundPlan(1599, 2000),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(recordSubscriptionRefundMock).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("skips the refund when the carve-outs meet or exceed the amount paid", async () => {
    // Degenerate safety: a tiny invoice (e.g. heavily comped) where fee +
    // term carve-out swallow everything must clamp to zero and skip, never
    // attempt a negative Stripe refund.
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_tiny" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_tiny",
          amount_paid: 5000,
          lines: {
            data: [{ description: "Carrier registration (10DLC)", amount: 1950 }]
          },
          payments: { data: [{ payment: { payment_intent: "pi_tiny" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_tiny", latest_charge: "ch_tiny" })
      },
      refunds: { create: vi.fn() }
    };

    await executeLifecyclePlan(
      refundPlan(5000, 19500),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(recordSubscriptionRefundMock).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("skips the refund entirely when only the carrier fee was paid", async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_fee_only" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_fee_only",
          amount_paid: 1950,
          lines: {
            data: [{ description: "Carrier registration (10DLC)", amount: 1950 }]
          },
          payments: { data: [{ payment: { payment_intent: "pi_fee_only" } }] }
        })
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_fee_only", latest_charge: "ch_fee_only" })
      },
      refunds: { create: vi.fn() }
    };

    await executeLifecyclePlan(
      refundPlan(1950),
      { businessId: "biz_1", vpsHost: null, customerProfileId: "prof_1" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(markRefundUsedMock).not.toHaveBeenCalled();
    expect(recordSubscriptionRefundMock).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
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
          .mockResolvedValueOnce({ status: "active", schedule: "sched_string" })
          .mockResolvedValueOnce({ status: "canceled", schedule: null })
          .mockRejectedValueOnce(new Error("missing")),
        cancel: vi.fn().mockResolvedValue({})
      },
      subscriptionSchedules: {
        release: vi
          .fn()
          .mockRejectedValueOnce(new Error("release failed"))
          .mockRejectedValueOnce("release string failed")
      }
    };
    const notFound = new HostingerApiError("/snapshot", 404, {}, "gone");
    const hostinger = {
      createSnapshot: vi.fn().mockResolvedValue({}),
      deleteSnapshot: vi.fn().mockRejectedValue(notFound),
      stopVirtualMachine: vi.fn().mockResolvedValue({}),
      disableBillingAutoRenewal: vi.fn().mockResolvedValue({}),
      enableBillingAutoRenewal: vi.fn().mockResolvedValue({})
    };

    await executeLifecyclePlan(
      {
        stripeOps: [
          { type: "set_cancel_at_period_end", stripeSubscriptionId: "sub_1", cancelAtPeriodEnd: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_1", releaseSchedule: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_string_schedule", releaseSchedule: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_2", releaseSchedule: true },
          { type: "cancel_subscription", stripeSubscriptionId: "sub_missing", releaseSchedule: true }
        ],
        telnyxOps: [],
        sshOps: [
          { type: "backup_durable_data", businessId: "biz_1", vpsHost: "1.2.3.4" },
          { type: "restore_durable_data", businessId: "biz_1", vpsHost: "1.2.3.5" }
        ],
        hostingerOps: [
          { type: "create_snapshot", virtualMachineId: 1 },
          { type: "delete_snapshot", virtualMachineId: 1 },
          { type: "stop_vm", virtualMachineId: 1 },
          { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs_1" },
          { type: "enable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs_1" }
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
            graceEndsAt: null,
            timeZone: null
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
    expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith("sched_string");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", {
      prorate: false,
      invoice_now: false
    });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_string_schedule", {
      prorate: false,
      invoice_now: false
    });
    expect(backupBusinessDataMock).toHaveBeenCalledWith({ businessId: "biz_1", vpsHost: "1.2.3.4" });
    expect(hostinger.createSnapshot).toHaveBeenCalledWith(1);
    expect(hostinger.stopVirtualMachine).toHaveBeenCalledWith(1);
    expect(hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs_1");
    expect(hostinger.enableBillingAutoRenewal).toHaveBeenCalledWith("hbs_1");
    expect(updateBusinessStatusMock).toHaveBeenCalledWith("biz_1", "wiped");
    // The wipe keeps the business row, so this is the only hook that ever
    // revokes the tenant's Nango workspace connections — and it runs AFTER
    // the stamp commits, so a failed stamp leaves integrations untouched.
    expect(revokeNangoConnectionsForBusinessMock).toHaveBeenCalledWith("biz_1");
    expect(revokeNangoConnectionsForBusinessMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateBusinessStatusMock.mock.invocationCallOrder[0]
    );
    expect(deleteBusinessBackupMock).toHaveBeenCalledWith("biz_1");
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringMatching(/scheduled/i),
      expect.objectContaining({
        text: expect.stringContaining("Your cancellation is scheduled"),
        html: expect.stringContaining("Your cancellation is scheduled")
      })
    );
  });

  it("dispatches wipe_byos_box to the BYOS wipe helper", async () => {
    wipeByosBoxMock.mockResolvedValueOnce(undefined);
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [
          { type: "wipe_byos_box", businessId: "biz_byos", vpsHost: "203.0.113.7" }
        ],
        dbUpdates: [],
        emailsToSend: []
      },
      { businessId: "biz_byos", vpsHost: "203.0.113.7" },
      { stripe: {} as never }
    );
    expect(wipeByosBoxMock).toHaveBeenCalledWith({
      businessId: "biz_byos",
      vpsHost: "203.0.113.7"
    });
  });

  it("dispatches ovh delete-at-expiration through the injected OVH client", async () => {
    const setDeleteAtExpiration = vi.fn().mockResolvedValue(undefined);
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        ovhOps: [{ type: "ovh_delete_at_expiration", serviceName: "vps-abc.vps.ovh.ca" }],
        sshOps: [],
        dbUpdates: [],
        emailsToSend: []
      },
      { businessId: "biz_ovh", vpsHost: null },
      { stripe: {} as never, ovh: { setDeleteAtExpiration } }
    );
    expect(setDeleteAtExpiration).toHaveBeenCalledWith("vps-abc.vps.ovh.ca", true);
  });

  it("slow phase logs (but survives) ovh op failures, Error and non-Error", async () => {
    const setDeleteAtExpiration = vi
      .fn()
      .mockRejectedValueOnce(new Error("ovh 403"))
      .mockRejectedValueOnce("plain string failure");
    const plan = {
      stripeOps: [],
      telnyxOps: [],
      hostingerOps: [],
      ovhOps: [
        { type: "ovh_delete_at_expiration" as const, serviceName: "vps-abc.vps.ovh.ca" }
      ],
      sshOps: [],
      dbUpdates: [],
      emailsToSend: []
    };
    await executeLifecyclePlanSlowPhase(plan, {}, {
      hostinger: {} as never,
      sendEmail: vi.fn(),
      ovh: { setDeleteAtExpiration }
    });
    await executeLifecyclePlanSlowPhase(plan, {}, {
      hostinger: {} as never,
      sendEmail: vi.fn(),
      ovh: { setDeleteAtExpiration }
    });
    expect(setDeleteAtExpiration).toHaveBeenCalledTimes(2);
  });

  it("dispatches the ops VPS deletion request to the ops inbox", async () => {
    const opsPlan: LifecyclePlan = {
      stripeOps: [],
      telnyxOps: [],
      sshOps: [],
      hostingerOps: [],
      dbUpdates: [],
      emailsToSend: [
        {
          type: "send_ops_vps_deletion_request",
          businessId: "biz_ops",
          virtualMachineId: 1800985,
          hostingerBillingSubscriptionId: "hbs_ops",
          ownerName: "Jane Doe",
          ownerEmail: "jane@example.com",
          tier: "standard",
          signupDate: "2026-06-01T00:00:00.000Z",
          refundIssued: false,
          cancelReason: "user_refund",
          vmState: "VM stopped, auto-renew disabled"
        }
      ]
    };

    await executeLifecyclePlan(opsPlan, { businessId: "biz_ops", vpsHost: null }, {
      sendEmail: sendOwnerEmailMock
    });
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("srv1800985.hstgr.cloud"),
      expect.objectContaining({
        text: expect.stringContaining("hpanel.hostinger.com/paid-invoices"),
        html: expect.stringContaining("Manual Hostinger deletion needed")
      })
    );
    const [, , , body] = sendOwnerEmailMock.mock.calls[0];
    expect((body as { text: string }).text).toContain("Stripe refund issued: no");

    // With a Stripe refund recorded in the same run, the email reports it
    // even though the planner stamped refundIssued=false.
    sendOwnerEmailMock.mockClear();
    await executeLifecyclePlanSlowPhase(opsPlan, {
      refund: { stripeRefundId: "re_1", stripeChargeId: "ch_1", amountCents: 100 }
    }, { sendEmail: sendOwnerEmailMock });
    const [, , , slowBody] = sendOwnerEmailMock.mock.calls[0];
    expect((slowBody as { text: string }).text).toContain("Stripe refund issued: yes");

    // Ops inbox override + localhost site-URL fallback.
    process.env.OPS_NOTIFICATION_EMAIL = "ops-staging@example.com";
    delete process.env.NEXT_PUBLIC_APP_URL;
    sendOwnerEmailMock.mockClear();
    await executeLifecyclePlan(opsPlan, { businessId: "biz_ops", vpsHost: null }, {
      sendEmail: sendOwnerEmailMock
    });
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "ops-staging@example.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
    delete process.env.OPS_NOTIFICATION_EMAIL;
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
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

    const chargeStringStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_charge_string" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          amount_paid: 1400,
          charge: "ch_string",
          payments: { data: [] }
        })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_string" }) }
    };
    await executeLifecyclePlan(
      refundPlan(1400),
      { businessId: "biz_1", vpsHost: null },
      { stripe: chargeStringStripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );
    expect(chargeStringStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ charge: "ch_string" }));

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

    const noAmountStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_no_amount" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          charge: "ch_no_amount",
          payments: { data: [] }
        })
      },
      refunds: { create: vi.fn() }
    };
    await executeLifecyclePlan(
      refundPlan(0),
      { businessId: "biz_1", vpsHost: null },
      { stripe: noAmountStripe as unknown as ExecutorDeps["stripe"], sendEmail: sendOwnerEmailMock }
    );
    expect(noAmountStripe.refunds.create).not.toHaveBeenCalled();

    const latestChargeMissingStripe = {
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_latest_missing" }) },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          amount_paid: 1000,
          payments: { data: [{ payment: { payment_intent: { latest_charge: null } } }] }
        })
      }
    };
    await expect(
      executeLifecyclePlan(
        refundPlan(),
        { businessId: "biz_1", vpsHost: null },
        { stripe: latestChargeMissingStripe as never }
      )
    ).rejects.toThrow("no charge on invoice");
  });

  it("handles auth-delete and email failure branches", async () => {
    createSupabaseServiceClientMock.mockResolvedValueOnce({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: { message: "user not found" } }) } }
    });
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
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
          telnyxOps: [],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [{ type: "delete_auth_user", supabaseUserId: "bad-user" }],
          emailsToSend: []
        },
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never }
      )
    ).rejects.toThrow("delete_auth_user: hard fail");

    createSupabaseServiceClientMock.mockResolvedValueOnce({
      auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: "string auth fail" }) } }
    });
    await expect(
      executeLifecyclePlan(
        {
          stripeOps: [],
          telnyxOps: [],
          hostingerOps: [],
          sshOps: [],
          dbUpdates: [{ type: "delete_auth_user", supabaseUserId: "string-error-user" }],
          emailsToSend: []
        },
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never }
      )
    ).rejects.toThrow("delete_auth_user: string auth fail");

    delete process.env.RESEND_API_KEY;
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
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
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
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
        telnyxOps: [],
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
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: vi.fn().mockRejectedValue(new Error("smtp down")) }
    );

    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
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
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never, sendEmail: vi.fn().mockRejectedValue("smtp string down") }
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
          telnyxOps: [],
          hostingerOps: [{ type: "create_snapshot", virtualMachineId: 1 }],
          sshOps: [],
          dbUpdates: [],
          emailsToSend: []
        },
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never, hostinger: hostinger as never }
      )
    ).rejects.toThrow("hostinger hard fail");

    deleteBusinessBackupMock.mockRejectedValueOnce("delete string failed");
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [{ type: "delete_backup_artifact", businessId: "biz_1" }],
        emailsToSend: []
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never }
    );

    deleteBusinessBackupMock.mockRejectedValueOnce(new Error("delete error failed"));
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [{ type: "delete_backup_artifact", businessId: "biz_1" }],
        emailsToSend: []
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never }
    );
  });

  it("records a pre-resolved refund without a live Stripe refund result", async () => {
    await executeLifecyclePlan(
      {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [
          {
            type: "record_refund",
            subscriptionId: "sub_row_pre_resolved",
            profileId: "prof_1",
            stripeRefundId: "re_pre",
            stripeChargeId: "ch_pre",
            amountCents: null,
            reason: "admin_force"
          }
        ],
        emailsToSend: []
      },
      { businessId: "biz_1", vpsHost: null },
      { stripe: {} as never }
    );

    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeRefundId: "re_pre",
        stripeChargeId: "ch_pre",
        amountCents: 0,
        reason: "admin_force"
      })
    );
  });
});

describe("executeLifecyclePlanFastPhase / executeLifecyclePlanSlowPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    backupBusinessDataMock.mockResolvedValue({});
    deleteBusinessBackupMock.mockResolvedValue(undefined);
    updateBusinessStatusMock.mockResolvedValue(undefined);
  });

  it("fast phase runs Stripe + DB ops only and hands the refund result to the slow phase email", async () => {
    // Fast phase: issues the Stripe refund + flips the subscription row.
    // We feed the resulting ExecutorResult into the slow phase so the
    // refund-issued email surfaces the amount we already recorded,
    // exactly matching the deferred-email contract expected by
    // /api/billing/cancel.
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({ latest_invoice: "in_fastslow" }),
        cancel: vi.fn().mockResolvedValue({})
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: "in_fastslow",
          amount_paid: 4200,
          charge: "ch_fastslow",
          payments: { data: [] }
        })
      },
      refunds: { create: vi.fn().mockResolvedValue({ id: "re_fastslow" }) }
    };

    const plan: LifecyclePlan = {
      telnyxOps: [],
      stripeOps: [
        {
          type: "refund_latest_charge",
          stripeSubscriptionId: "sub_fastslow",
          reason: "thirty_day_money_back",
          usageCarveOutCents: 0
        },
        {
          type: "cancel_subscription",
          stripeSubscriptionId: "sub_fastslow",
          releaseSchedule: false
        }
      ],
      sshOps: [{ type: "backup_durable_data", businessId: "biz_fastslow", vpsHost: "1.2.3.4" }],
      hostingerOps: [
        { type: "create_snapshot", virtualMachineId: 9 },
        { type: "stop_vm", virtualMachineId: 9 },
        { type: "disable_billing_auto_renewal", hostingerBillingSubscriptionId: "hbs_9" }
      ],
      dbUpdates: [
        {
          type: "update_subscription",
          subscriptionId: "sub_row_fastslow",
          patch: { status: "canceled", grace_ends_at: "2026-06-01T00:00:00.000Z" }
        },
        { type: "mark_refund_used", profileId: "prof_fs", at: "2026-05-01T00:00:00.000Z" },
        {
          type: "record_refund",
          subscriptionId: "sub_row_fastslow",
          profileId: "prof_fs",
          stripeRefundId: null,
          stripeChargeId: null,
          amountCents: 4200,
          reason: "thirty_day_money_back"
        }
      ],
      emailsToSend: [
        {
          type: "send_refund_issued",
          toEmail: "owner@example.com",
          businessId: "biz_fastslow",
          amountCents: 4200
        }
      ]
    };

    const hostinger = {
      createSnapshot: vi.fn().mockResolvedValue({}),
      stopVirtualMachine: vi.fn().mockResolvedValue({}),
      disableBillingAutoRenewal: vi.fn().mockResolvedValue({})
    };

    const fastResult = await executeLifecyclePlanFastPhase(
      plan,
      { businessId: "biz_fastslow", vpsHost: "1.2.3.4", customerProfileId: "prof_fs" },
      { stripe: stripe as unknown as ExecutorDeps["stripe"] }
    );

    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_fastslow", {
      prorate: false,
      invoice_now: false
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(
      "sub_row_fastslow",
      expect.objectContaining({ status: "canceled" })
    );
    expect(markRefundUsedMock).toHaveBeenCalledWith("prof_fs", expect.any(Date));
    expect(recordSubscriptionRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ stripeRefundId: "re_fastslow", amountCents: 4200 })
    );
    expect(backupBusinessDataMock).not.toHaveBeenCalled();
    expect(hostinger.createSnapshot).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(fastResult.refund).toEqual({
      stripeRefundId: "re_fastslow",
      stripeChargeId: "ch_fastslow",
      amountCents: 4200
    });

    await executeLifecyclePlanSlowPhase(plan, fastResult, {
      hostinger: hostinger as never,
      sendEmail: sendOwnerEmailMock
    });

    expect(backupBusinessDataMock).toHaveBeenCalledWith({
      businessId: "biz_fastslow",
      vpsHost: "1.2.3.4"
    });
    expect(hostinger.createSnapshot).toHaveBeenCalledWith(9);
    expect(hostinger.stopVirtualMachine).toHaveBeenCalledWith(9);
    expect(hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs_9");
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "owner@example.com",
      expect.stringMatching(/refund/i),
      expect.objectContaining({
        text: expect.stringContaining("$42.00"),
        html: expect.stringContaining("$42.00")
      })
    );
  });

  it("slow phase swallows SSH, Hostinger, and email failures so the background task can never crash the server", async () => {
    // The /api/billing/cancel route kicks the slow phase off as a
    // fire-and-forget Promise. Any unhandled rejection would surface as
    // an unhandledRejection on the serverless worker — assert every
    // failure class is internalised. Mix Error and non-Error rejection
    // values to exercise both branches of the defensive
    // `err instanceof Error ? err.message : String(err)` normalisation.
    backupBusinessDataMock.mockRejectedValueOnce(new Error("ssh pipe broken"));
    const hostinger = {
      // Non-Error reject value — forces the String(err) branch on the
      // hostinger error path.
      createSnapshot: vi.fn().mockRejectedValue("hostinger 500"),
      deleteSnapshot: vi.fn(),
      stopVirtualMachine: vi.fn(),
      disableBillingAutoRenewal: vi.fn()
    };

    await executeLifecyclePlanSlowPhase(
      {
        stripeOps: [],
        telnyxOps: [],
        sshOps: [{ type: "backup_durable_data", businessId: "biz_slow", vpsHost: "1.2.3.4" }],
        hostingerOps: [{ type: "create_snapshot", virtualMachineId: 7 }],
        dbUpdates: [],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner@example.com",
            businessId: "biz_slow",
            reason: "user_refund",
            effectiveAt: "2026-04-01T00:00:00.000Z",
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      {},
      {
        hostinger: hostinger as never,
        // Non-Error reject value — forces String(err) on the email path.
        sendEmail: vi.fn().mockRejectedValue("smtp down")
      }
    );

    expect(backupBusinessDataMock).toHaveBeenCalled();
    expect(hostinger.createSnapshot).toHaveBeenCalled();
  });

  it("slow phase exercises the Error branch of ssh, hostinger, and email error normalisation", async () => {
    backupBusinessDataMock.mockRejectedValueOnce("ssh non-error");
    const hostinger = {
      createSnapshot: vi.fn().mockRejectedValue(new Error("hostinger error-branch")),
      deleteSnapshot: vi.fn(),
      stopVirtualMachine: vi.fn(),
      disableBillingAutoRenewal: vi.fn()
    };
    await executeLifecyclePlanSlowPhase(
      {
        stripeOps: [],
        telnyxOps: [],
        sshOps: [{ type: "backup_durable_data", businessId: "biz_slow2", vpsHost: "1.2.3.4" }],
        hostingerOps: [{ type: "create_snapshot", virtualMachineId: 11 }],
        dbUpdates: [],
        emailsToSend: [
          {
            type: "send_cancel_confirmation",
            toEmail: "owner2@example.com",
            businessId: "biz_slow2",
            reason: "user_refund",
            effectiveAt: "2026-04-01T00:00:00.000Z",
            graceEndsAt: "2026-05-01T00:00:00.000Z",
            timeZone: null
          }
        ]
      },
      {},
      {
        hostinger: hostinger as never,
        sendEmail: vi.fn().mockRejectedValue(new Error("smtp error-branch"))
      }
    );
    expect(backupBusinessDataMock).toHaveBeenCalled();
    expect(hostinger.createSnapshot).toHaveBeenCalled();
  });

  describe("return_vps_to_pool (fleet economics Phase B)", () => {
    function poolPlan(): LifecyclePlan {
      return {
        stripeOps: [],
        telnyxOps: [],
        hostingerOps: [],
        sshOps: [],
        dbUpdates: [
          {
            type: "return_vps_to_pool",
            virtualMachineId: 1800985,
            plan: "kvm2",
            hostingerBillingSubscriptionId: "hbs-1",
            notes: "returned by user_refund cancel of business biz_1"
          }
        ],
        emailsToSend: []
      };
    }

    const stubDeps: ExecutorDeps = {
      stripe: {} as never,
      hostinger: {} as never,
      sendEmail: vi.fn()
    };

    it("writes the box back to the vps_inventory pool", async () => {
      releaseVpsToPoolMock.mockResolvedValueOnce(undefined);
      await executeLifecyclePlan(poolPlan(), { businessId: "biz_1", vpsHost: null }, stubDeps);
      expect(releaseVpsToPoolMock).toHaveBeenCalledWith({
        vmId: 1800985,
        plan: "kvm2",
        hostingerBillingSubscriptionId: "hbs-1",
        notes: "returned by user_refund cancel of business biz_1"
      });
    });

    // The churned-box runway fix: a canceled TERM box can carry many months
    // of prepaid time, and claimAvailableVps ranks unknown expiry LAST, so
    // the pool row has to learn its paid-through as it enters the pool
    // rather than a day later when the billing-posture cron catches up.
    it("stamps the box's Hostinger paid-through onto the pool row", async () => {
      releaseVpsToPoolMock.mockResolvedValueOnce(undefined);
      const hostinger = {
        listBillingSubscriptions: vi.fn(async () => [
          { id: "hbs-1", expires_at: "2028-07-01T00:00:00Z" }
        ])
      };
      await executeLifecyclePlanSlowPhase(poolPlan(), {}, {
        hostinger: hostinger as never,
        sendEmail: vi.fn()
      });
      expect(releaseVpsToPoolMock).toHaveBeenCalledWith(
        expect.objectContaining({ vmId: 1800985, expiresAt: "2028-07-01T00:00:00Z" })
      );
    });

    // Forwarding a null would ERASE a paid-through already on the row (the
    // grace-expired wipe re-emits this op after the cancel already pooled
    // the box), so an unresolvable expiry must omit the key entirely.
    it("omits expiresAt when Hostinger cannot resolve the paid-through", async () => {
      releaseVpsToPoolMock.mockResolvedValueOnce(undefined);
      const hostinger = {
        listBillingSubscriptions: vi.fn(async () => {
          throw new Error("hostinger 503");
        })
      };
      await executeLifecyclePlanSlowPhase(poolPlan(), {}, {
        hostinger: hostinger as never,
        sendEmail: vi.fn()
      });
      expect(releaseVpsToPoolMock.mock.calls[0][0]).not.toHaveProperty("expiresAt");
    });

    it("swallows a pool write failure, inventory is an optimization, never a cancel blocker", async () => {
      releaseVpsToPoolMock.mockRejectedValueOnce(new Error("pool db down"));
      await expect(
        executeLifecyclePlan(poolPlan(), { businessId: "biz_1", vpsHost: null }, stubDeps)
      ).resolves.toEqual({});
      expect(releaseVpsToPoolMock).toHaveBeenCalled();
    });

    it("stringifies a non-Error pool write failure", async () => {
      releaseVpsToPoolMock.mockRejectedValueOnce("pool string boom");
      await expect(
        executeLifecyclePlan(poolPlan(), { businessId: "biz_1", vpsHost: null }, stubDeps)
      ).resolves.toEqual({});
    });

    it("fast phase DEFERS the pool return, the box must not be claimable before backup + stop", async () => {
      // A box marked `available` is immediately claimable by a concurrent
      // signup, whose adopt path RECREATES (wipes) the VM. The fast phase
      // runs before the SSH backup and stop_vm, so it must skip this op.
      await executeLifecyclePlanFastPhase(
        poolPlan(),
        { businessId: "biz_1", vpsHost: null },
        stubDeps
      );
      expect(releaseVpsToPoolMock).not.toHaveBeenCalled();
    });

    it("slow phase runs the pool return after backup + Hostinger teardown", async () => {
      const callOrder: string[] = [];
      backupBusinessDataMock.mockImplementation(async () => {
        callOrder.push("backup");
        return {};
      });
      const hostinger = {
        stopVirtualMachine: vi.fn(async () => {
          callOrder.push("stop_vm");
          return {};
        })
      };
      releaseVpsToPoolMock.mockImplementation(async () => {
        callOrder.push("pool_return");
      });

      const plan = poolPlan();
      plan.sshOps = [
        { type: "backup_durable_data", businessId: "biz_1", vpsHost: "1.2.3.4" }
      ];
      plan.hostingerOps = [{ type: "stop_vm", virtualMachineId: 1800985 }];

      await executeLifecyclePlanSlowPhase(plan, {}, {
        hostinger: hostinger as never,
        sendEmail: vi.fn()
      });

      expect(callOrder).toEqual(["backup", "stop_vm", "pool_return"]);
      expect(releaseVpsToPoolMock).toHaveBeenCalledWith(
        expect.objectContaining({ vmId: 1800985, plan: "kvm2" })
      );
    });

    it("slow phase swallows pool return failures like every other slow op", async () => {
      releaseVpsToPoolMock.mockRejectedValueOnce(new Error("pool down"));
      await expect(
        executeLifecyclePlanSlowPhase(poolPlan(), {}, {
          hostinger: {} as never,
          sendEmail: vi.fn()
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("release_did (terminal DID teardown)", () => {
    function didPlan(): LifecyclePlan {
      return {
        stripeOps: [],
        hostingerOps: [],
        sshOps: [],
        telnyxOps: [{ type: "release_did", e164: "+16025550100", businessId: "biz_1" }],
        dbUpdates: [],
        emailsToSend: []
      };
    }

    function fakeTelnyx(deleteImpl: ReturnType<typeof vi.fn>): TelnyxNumbersClient {
      return { deletePhoneNumber: deleteImpl } as unknown as TelnyxNumbersClient;
    }

    beforeEach(() => {
      deleteTelnyxVoiceRouteMock.mockResolvedValue(undefined);
      upsertBusinessTelnyxSettingsMock.mockResolvedValue({});
      sendOpsDidReleaseFailedEmailMock.mockResolvedValue(undefined);
    });

    it("releases at Telnyx, then removes the route row and clears the SMS from-number", async () => {
      const del = vi.fn().mockResolvedValue({ id: "pn_1" });
      await executeLifecyclePlan(
        didPlan(),
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never, sendEmail: vi.fn(), telnyxNumbers: fakeTelnyx(del) }
      );
      expect(del).toHaveBeenCalledWith("+16025550100");
      expect(deleteTelnyxVoiceRouteMock).toHaveBeenCalledWith("+16025550100");
      expect(upsertBusinessTelnyxSettingsMock).toHaveBeenCalledWith({
        businessId: "biz_1",
        telnyxSmsFromE164: null
      });
      // Clean release: no manual-action alert.
      expect(sendOpsDidReleaseFailedEmailMock).not.toHaveBeenCalled();
    });

    it("tolerates a 404 (number already released) and still cleans up routing rows", async () => {
      const del = vi
        .fn()
        .mockRejectedValue(new TelnyxApiError("/phone_numbers/x", 404, "not found"));
      await executeLifecyclePlan(
        didPlan(),
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never, sendEmail: vi.fn(), telnyxNumbers: fakeTelnyx(del) }
      );
      expect(deleteTelnyxVoiceRouteMock).toHaveBeenCalledWith("+16025550100");
      expect(upsertBusinessTelnyxSettingsMock).toHaveBeenCalled();
    });

    it("on a non-404 Telnyx failure keeps the route row (so the retry can find the DID) and never throws", async () => {
      const del = vi
        .fn()
        .mockRejectedValue(new TelnyxApiError("/phone_numbers/x", 500, "server error"));
      await expect(
        executeLifecyclePlan(
          didPlan(),
          { businessId: "biz_1", vpsHost: null },
          { stripe: {} as never, sendEmail: vi.fn(), telnyxNumbers: fakeTelnyx(del) }
        )
      ).resolves.toBeTruthy();
      expect(deleteTelnyxVoiceRouteMock).not.toHaveBeenCalled();
      expect(upsertBusinessTelnyxSettingsMock).not.toHaveBeenCalled();
      // Nothing retries after the wipe stamp, so ops must be paged to
      // release the number manually (Bugbot: wipe stamp blocks DID retry).
      expect(sendOpsDidReleaseFailedEmailMock).toHaveBeenCalledWith({
        businessId: "biz_1",
        e164: "+16025550100",
        reason: expect.stringContaining("server error")
      });
    });


    it("swallows routing-cleanup failures, a wipe must not fail over a $1 number", async () => {
      const del = vi.fn().mockResolvedValue({ id: "pn_1" });
      deleteTelnyxVoiceRouteMock.mockRejectedValueOnce(new Error("db down"));
      await expect(
        executeLifecyclePlan(
          didPlan(),
          { businessId: "biz_1", vpsHost: null },
          { stripe: {} as never, sendEmail: vi.fn(), telnyxNumbers: fakeTelnyx(del) }
        )
      ).resolves.toBeTruthy();

      // Non-Error rejection shape takes the String(err) branch.
      deleteTelnyxVoiceRouteMock.mockRejectedValueOnce("string blip");
      await expect(
        executeLifecyclePlan(
          didPlan(),
          { businessId: "biz_1", vpsHost: null },
          { stripe: {} as never, sendEmail: vi.fn(), telnyxNumbers: fakeTelnyx(del) }
        )
      ).resolves.toBeTruthy();
    });

    it("skips the op (loudly) when no Telnyx client is available and pages ops", async () => {
      const prevKey = process.env.TELNYX_API_KEY;
      delete process.env.TELNYX_API_KEY;
      try {
        await executeLifecyclePlan(
          didPlan(),
          { businessId: "biz_1", vpsHost: null },
          { stripe: {} as never, sendEmail: vi.fn() }
        );
        expect(deleteTelnyxVoiceRouteMock).not.toHaveBeenCalled();
        expect(sendOpsDidReleaseFailedEmailMock).toHaveBeenCalledWith({
          businessId: "biz_1",
          e164: "+16025550100",
          reason: expect.stringContaining("TELNYX_API_KEY missing")
        });
      } finally {
        if (prevKey !== undefined) process.env.TELNYX_API_KEY = prevKey;
      }
    });

    it("fast phase skips telnyxOps; slow phase runs them", async () => {
      const del = vi.fn().mockResolvedValue({ id: "pn_1" });
      const plan = didPlan();

      await executeLifecyclePlanFastPhase(
        plan,
        { businessId: "biz_1", vpsHost: null },
        { stripe: {} as never, telnyxNumbers: fakeTelnyx(del) }
      );
      expect(del).not.toHaveBeenCalled();

      await executeLifecyclePlanSlowPhase(plan, {}, {
        hostinger: {} as never,
        sendEmail: vi.fn(),
        telnyxNumbers: fakeTelnyx(del)
      });
      expect(del).toHaveBeenCalledWith("+16025550100");
      expect(deleteTelnyxVoiceRouteMock).toHaveBeenCalledWith("+16025550100");
    });
  });
});
