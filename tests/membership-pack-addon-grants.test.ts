import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const {
  getSubscriptionMock,
  rpcMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerInfoMock
} = vi.hoisted(() => ({
  getSubscriptionMock: vi.fn(),
  rpcMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/subscriptions")>();
  return {
    ...actual,
    getSubscription: getSubscriptionMock,
    stripeSubscriptionPeriodCache: vi.fn((sub: { current_period_end?: number }) => {
      if (typeof sub.current_period_end === "number") {
        return {
          stripe_current_period_end: new Date(sub.current_period_end * 1000).toISOString()
        };
      }
      return {};
    })
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    rpc: rpcMock
  }))
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

import {
  applyMembershipPackAddonsFromCheckout,
  applyMembershipPackAddonsFromInvoice
} from "@/lib/billing/membership-pack-addon-grants";

function makeInvoice(id = "in_1"): Stripe.Invoice {
  return { id, created: 1_700_000_000 } as unknown as Stripe.Invoice;
}

function makeSub(metadata: Record<string, string>): Stripe.Subscription {
  return {
    id: "sub_live",
    status: "active",
    current_period_end: 1_700_100_000,
    metadata
  } as unknown as Stripe.Subscription;
}

describe("applyMembershipPackAddonsFromInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSubscriptionMock.mockResolvedValue({
      id: "sub_row",
      status: "active",
      stripe_subscription_id: "sub_live"
    });
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it("no-ops when metadata has no pack add-ons", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ businessId: "biz-1" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("grants qty × unit × months with invoice-keyed source ids", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice("in_abc"),
      stripeSubscription: makeSub({
        addonVoice: "min_30:3:1800",
        addonSms: "texts_500:1:500",
        addonChat: "usd_5:2:5000000"
      }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "apply_voice_bonus_grant_from_checkout",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_abc:voice:min_30",
        p_seconds_purchased: 5400
      })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_sms_bonus_grant_from_checkout",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_abc:sms:texts_500",
        p_texts_purchased: 500
      })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_chat_credit_grant_from_checkout",
      expect.objectContaining({
        p_checkout_session_id: "inv_in_abc:chat:usd_5",
        p_credit_micros: 10_000_000
      })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "voice_sync_low_balance_alert_armed_for_business",
      expect.objectContaining({ p_business_id: "biz-1" })
    );
  });

  it("multiplies annual grants by 12", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice("in_yr"),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "annual",
      eventId: "evt_1"
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_voice_bonus_grant_from_checkout",
      expect.objectContaining({ p_seconds_purchased: 1800 * 12 })
    );
  });

  it("blocks when local subscription is not active", async () => {
    getSubscriptionMock.mockResolvedValue({ status: "canceled", stripe_subscription_id: "sub_live" });
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("blocks when Stripe subscription is not entitled", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: {
        ...makeSub({ addonVoice: "min_30:1:1800" }),
        status: "canceled"
      } as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("warns when voice re-arm RPC fails", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "voice_sync_low_balance_alert_armed_for_business") {
        return { data: null, error: { message: "arm fail" } };
      }
      return { data: { ok: true }, error: null };
    });
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "membership_pack_addon voice re-arm failed",
      expect.objectContaining({ businessId: "biz-1", error: "arm fail" })
    );
  });

  it("skips voice re-arm when grant RPC returns ok:false", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "apply_voice_bonus_grant_from_checkout") {
        return { data: { ok: false, reason: "no_active_subscription" }, error: null };
      }
      return { data: { ok: true }, error: null };
    });
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalledWith(
      "voice_sync_low_balance_alert_armed_for_business",
      expect.anything()
    );
  });

  it("logs grant RPC errors without throwing", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "rpc boom" } });
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({
        addonVoice: "min_30:1:1800",
        addonSms: "texts_500:1:500",
        addonChat: "usd_5:1:5000000"
      }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("expires at period end when later than purchased_at+30d", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: {
        ...makeSub({ addonSms: "texts_500:1:500" }),
        current_period_end: 1_703_000_000
      } as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    const call = rpcMock.mock.calls.find((c) => c[0] === "apply_sms_bonus_grant_from_checkout");
    expect(call?.[1].p_expires_at).toBe(new Date(1_703_000_000_000).toISOString());
  });

  it("expires at purchased_at+30d when later than period end", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: {
        ...makeSub({ addonSms: "texts_500:1:500" }),
        current_period_end: 1_700_000_100
      } as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    const call = rpcMock.mock.calls.find((c) => c[0] === "apply_sms_bonus_grant_from_checkout");
    expect(call?.[1].p_expires_at).toBe(new Date(1_702_592_000_000).toISOString());
  });

  it("blocks when period end is missing", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: {
        id: "sub_live",
        status: "active",
        metadata: { addonVoice: "min_30:1:1800" }
      } as unknown as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("checkout helper is a no-op (grants move to invoice.paid)", async () => {
    await applyMembershipPackAddonsFromCheckout(
      {
        id: "cs_1",
        metadata: { businessId: "biz-1", addonVoice: "min_30:1:1800" }
      } as unknown as Stripe.Checkout.Session,
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("falls back when invoice.created is missing and accepts trialing status", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: { id: "in_trial", created: "nope" } as unknown as Stripe.Invoice,
      stripeSubscription: {
        ...makeSub({ addonVoice: "min_30:1:1800" }),
        status: "trialing"
      } as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_voice_bonus_grant_from_checkout",
      expect.objectContaining({ p_seconds_purchased: 1800 })
    );
  });

  it("blocks when local subscription has no stripe id", async () => {
    getSubscriptionMock.mockResolvedValue({ status: "active", stripe_subscription_id: null });
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("handles null subscription metadata and null local subscription row", async () => {
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: {
        id: "sub_live",
        status: "active",
        current_period_end: 1_700_100_000,
        metadata: null
      } as unknown as Stripe.Subscription,
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(rpcMock).not.toHaveBeenCalled();

    getSubscriptionMock.mockResolvedValue(null);
    await applyMembershipPackAddonsFromInvoice({
      invoice: makeInvoice(),
      stripeSubscription: makeSub({ addonVoice: "min_30:1:1800" }),
      businessId: "biz-1",
      billingPeriod: "monthly",
      eventId: "evt_1"
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "membership_pack_addon invoice: no active local subscription; grant blocked",
      expect.objectContaining({ status: null })
    );
  });
});
