import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyInvoicePaymentFailed } from "@/lib/billing/payment-failed-notify";
import type { SubscriptionRow } from "@/lib/db/subscriptions";

const NOW = new Date("2026-09-17T01:04:48.000Z");
const GRACE = "2026-10-17T01:04:48.000Z";

function makeSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_row",
    business_id: "6cc2d7ba-a007-49d4-93a4-586967e147f1",
    stripe_customer_id: "cus_Uu3hTLCgROTtbP",
    stripe_subscription_id: "sub_1TuFa5Fv205jOP2fl1ze0t2n",
    tier: "standard",
    status: "active",
    billing_period: "monthly",
    renewal_at: null,
    commitment_months: 1,
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: null,
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
    membership_pack_addons: null,
    discount_coupon_id: null,
    discount_name: null,
    discount_percent_off: null,
    discount_amount_off_cents: null,
    discount_duration: null,
    discount_duration_in_months: null,
    discount_started_at: null,
    discount_ends_at: null,
    monthly_intro_nudge_sent_at: null,
    monthly_intro_ends_at: null,
    contract_term_nudge_sent_at: null,
    created_at: "2026-07-17T00:00:00.000Z",
    ...overrides
  } as SubscriptionRow;
}

describe("notifyInvoicePaymentFailed", () => {
  const sendOwner = vi.fn();
  const sendOps = vi.fn();
  const getBusinessRow = vi.fn();
  const resolveLocale = vi.fn().mockResolvedValue("en");

  beforeEach(() => {
    vi.clearAllMocks();
    sendOwner.mockResolvedValue(undefined);
    sendOps.mockResolvedValue(true);
    getBusinessRow.mockResolvedValue({
      name: "Scar Fairy",
      owner_name: "Selena Breed",
      owner_email: "selena@example.com",
      timezone: "America/New_York"
    });
    resolveLocale.mockResolvedValue("en");
  });

  const invoice = {
    id: "in_1UGSoIFv205jOP2fQZJohEsm",
    amount_due: 18900,
    currency: "usd",
    charge: {
      payment_method_details: { card: { brand: "amex", last4: "3042" } },
      failure_code: "card_declined",
      outcome: { reason: "do_not_honor" }
    }
  };

  it("emails the owner and ops on an active invoice decline", async () => {
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub(),
        invoice,
        stripeSubscriptionId: "sub_1TuFa5Fv205jOP2fl1ze0t2n",
        willAutoCancel: true
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com"
      }
    );

    expect(sendOwner).toHaveBeenCalledWith(
      "re_test",
      "selena@example.com",
      expect.stringMatching(/declined/i),
      expect.objectContaining({
        text: expect.stringContaining("Amex ending 3042")
      })
    );
    expect(sendOps).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "6cc2d7ba-a007-49d4-93a4-586967e147f1",
        businessName: "Scar Fairy",
        invoiceId: "in_1UGSoIFv205jOP2fQZJohEsm",
        willAutoCancel: true,
        failureDetail: expect.stringContaining("do_not_honor")
      })
    );
  });

  it("still pages ops when RESEND_API_KEY is missing (owner mail skipped)", async () => {
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub(),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: true
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: undefined,
        appUrl: "https://www.example.com"
      }
    );
    expect(sendOwner).not.toHaveBeenCalled();
    expect(sendOps).toHaveBeenCalled();
  });

  it("skips owner mail when there is no owner email, still pages ops", async () => {
    getBusinessRow.mockResolvedValue({ name: "Scar Fairy", owner_email: "", owner_name: null });
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub(),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: true
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com"
      }
    );
    expect(sendOwner).not.toHaveBeenCalled();
    expect(sendOps).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: "(none on file)" })
    );
  });

  it("does not email the owner for a pending row that will not auto-cancel", async () => {
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub({ status: "pending" }),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: false
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com"
      }
    );
    expect(sendOwner).not.toHaveBeenCalled();
    expect(sendOps).toHaveBeenCalledWith(expect.objectContaining({ willAutoCancel: false }));
  });

  it("emails an in-grace owner even when willAutoCancel is false", async () => {
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub({
          status: "canceled",
          cancel_reason: "payment_failed",
          grace_ends_at: GRACE,
          canceled_at: NOW.toISOString(),
          wiped_at: null
        }),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: false
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com"
      }
    );
    expect(sendOwner).toHaveBeenCalled();
    expect(sendOwner.mock.calls[0][3].text).toMatch(/until/i);
  });

  it("omits timezone when the business row has none", async () => {
    getBusinessRow.mockResolvedValue({
      name: "Scar Fairy",
      owner_name: "Selena Breed",
      owner_email: "selena@example.com"
    });
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub(),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: true
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com/"
      }
    );
    expect(sendOwner).toHaveBeenCalled();
  });

  it("logs and continues when owner mail throws", async () => {
    sendOwner.mockRejectedValue(new Error("smtp down"));
    await notifyInvoicePaymentFailed(
      {
        existing: makeSub(),
        invoice,
        stripeSubscriptionId: "sub_x",
        willAutoCancel: true
      },
      {
        getBusinessRow,
        sendOwner,
        sendOps,
        resolveLocale,
        resendApiKey: "re_test",
        appUrl: "https://www.example.com"
      }
    );
    expect(sendOps).toHaveBeenCalled();
  });
});
