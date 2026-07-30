import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const {
  getSubscriptionMock,
  stripeRetrieveMock,
  rpcMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerInfoMock
} = vi.hoisted(() => ({
  getSubscriptionMock: vi.fn(),
  stripeRetrieveMock: vi.fn(),
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

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: stripeRetrieveMock }
  })
}));

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

import { applyMembershipPackAddonsFromCheckout } from "@/lib/billing/membership-pack-addon-grants";

function makeSession(metadata: Record<string, string>): Stripe.Checkout.Session {
  return {
    id: "cs_membership_1",
    created: 1_700_000_000,
    metadata
  } as unknown as Stripe.Checkout.Session;
}

describe("applyMembershipPackAddonsFromCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSubscriptionMock.mockResolvedValue({
      id: "sub_row",
      status: "active",
      stripe_subscription_id: "sub_live"
    });
    stripeRetrieveMock.mockResolvedValue({
      id: "sub_live",
      status: "active",
      current_period_end: 1_700_100_000
    });
    rpcMock.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it("no-ops when metadata has no pack add-ons", async () => {
    await applyMembershipPackAddonsFromCheckout(
      makeSession({ businessId: "biz-1" }),
      "evt_1"
    );
    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("no-ops when session metadata is null", async () => {
    const session = {
      id: "cs_membership_1",
      created: 1_700_000_000,
      metadata: null
    } as unknown as Stripe.Checkout.Session;
    await applyMembershipPackAddonsFromCheckout(session, "evt_1");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("warns and returns when businessId is missing", async () => {
    await applyMembershipPackAddonsFromCheckout(
      makeSession({ addonVoicePackId: "min_30", addonVoiceSeconds: "1800" }),
      "evt_1"
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "membership_pack_addon: missing businessId",
      expect.objectContaining({ sessionId: "cs_membership_1" })
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("blocks when there is no active subscription", async () => {
    getSubscriptionMock.mockResolvedValue({
      id: "sub_row",
      status: "pending",
      stripe_subscription_id: "sub_live"
    });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("no active subscription"),
      expect.any(Object)
    );
  });

  it("blocks when Stripe retrieve fails", async () => {
    stripeRetrieveMock.mockRejectedValue(new Error("stripe down"));
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("blocks when Stripe subscription is not entitled", async () => {
    stripeRetrieveMock.mockResolvedValue({ id: "sub_live", status: "canceled" });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonChatPackId: "usd_5",
        addonChatMicros: "5000000"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("blocks when period end is missing", async () => {
    stripeRetrieveMock.mockResolvedValue({ id: "sub_live", status: "active" });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("grants voice, sms, and chat packs and re-arms voice alert", async () => {
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500",
        addonChatPackId: "usd_5",
        addonChatMicros: "5000000"
      }),
      "evt_1"
    );

    expect(rpcMock).toHaveBeenCalledWith(
      "apply_voice_bonus_grant_from_checkout",
      expect.objectContaining({
        p_business_id: "biz-1",
        p_checkout_session_id: "cs_membership_1",
        p_seconds_purchased: 1800
      })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "voice_sync_low_balance_alert_armed_for_business",
      expect.objectContaining({ p_business_id: "biz-1" })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_sms_bonus_grant_from_checkout",
      expect.objectContaining({ p_texts_purchased: 500 })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_chat_credit_grant_from_checkout",
      expect.objectContaining({ p_credit_micros: 5_000_000 })
    );
  });

  it("logs RPC failures without throwing", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "rpc boom" } });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500",
        addonChatPackId: "usd_5",
        addonChatMicros: "5000000"
      }),
      "evt_1"
    );
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("skips voice re-arm when grant RPC returns ok:false", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "apply_voice_bonus_grant_from_checkout") {
        return { data: { ok: false, reason: "no_active_subscription" }, error: null };
      }
      return { data: { ok: true }, error: null };
    });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "voice_sync_low_balance_alert_armed_for_business",
      expect.anything()
    );
  });

  it("warns when voice re-arm RPC fails", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "voice_sync_low_balance_alert_armed_for_business") {
        return { data: null, error: { message: "arm fail" } };
      }
      return { data: { ok: true }, error: null };
    });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "membership_pack_addon voice re-arm failed",
      expect.objectContaining({ businessId: "biz-1", error: "arm fail" })
    );
  });

  it("expires at purchased_at+30d when that is later than period end", async () => {
    stripeRetrieveMock.mockResolvedValue({
      id: "sub_live",
      status: "active",
      current_period_end: 1_700_000_100
    });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500"
      }),
      "evt_1"
    );
    const call = rpcMock.mock.calls.find(
      (c) => c[0] === "apply_sms_bonus_grant_from_checkout"
    );
    // created 1700000000 + 30d = 1702592000
    expect(call?.[1].p_expires_at).toBe(new Date(1_702_592_000_000).toISOString());
  });

  it("expires at Stripe period end when that is later than purchased_at+30d", async () => {
    stripeRetrieveMock.mockResolvedValue({
      id: "sub_live",
      status: "active",
      current_period_end: 1_703_000_000
    });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500"
      }),
      "evt_1"
    );
    const call = rpcMock.mock.calls.find(
      (c) => c[0] === "apply_sms_bonus_grant_from_checkout"
    );
    expect(call?.[1].p_expires_at).toBe(new Date(1_703_000_000_000).toISOString());
  });

  it("stringifies non-Error Stripe retrieve failures", async () => {
    stripeRetrieveMock.mockRejectedValue("stripe down");
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "membership_pack_addon shared: Stripe subscription retrieve failed",
      expect.objectContaining({ error: "stripe down" })
    );
  });

  it("blocks when subscription has no stripe id", async () => {
    getSubscriptionMock.mockResolvedValue({ id: "sub_row", status: "active" });
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonVoicePackId: "min_30",
        addonVoiceSeconds: "1800"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("blocks when getSubscription returns null", async () => {
    getSubscriptionMock.mockResolvedValue(null);
    await applyMembershipPackAddonsFromCheckout(
      makeSession({
        businessId: "biz-1",
        addonChatPackId: "usd_5",
        addonChatMicros: "5000000"
      }),
      "evt_1"
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("accepts trialing Stripe status and falls back when session.created is missing", async () => {
    stripeRetrieveMock.mockResolvedValue({
      id: "sub_live",
      status: "trialing",
      current_period_end: 1_700_100_000
    });
    const session = {
      id: "cs_membership_1",
      created: "not-a-number",
      metadata: {
        businessId: "biz-1",
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500"
      }
    } as unknown as Stripe.Checkout.Session;
    await applyMembershipPackAddonsFromCheckout(session, "evt_1");
    expect(rpcMock).toHaveBeenCalledWith(
      "apply_sms_bonus_grant_from_checkout",
      expect.objectContaining({ p_texts_purchased: 500 })
    );
  });
});
