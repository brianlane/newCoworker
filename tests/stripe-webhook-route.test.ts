import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn().mockResolvedValue({
    current_period_start: 1700000000,
    current_period_end: 1702678400
  })
}));

vi.mock("@/lib/stripe/client", () => ({
  ensureCommitmentSchedule: vi.fn(),
  verifyWebhook: vi.fn(),
  getStripe: vi.fn(() => ({
    subscriptions: { retrieve: mockStripeRetrieve }
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

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}));

import { POST } from "@/app/api/webhooks/stripe/route";
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

  it("marks subscription past_due on async payment failure", async () => {
    vi.mocked(verifyWebhook).mockReturnValue({
      id: "evt_2",
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          metadata: {
            businessId: "biz_2"
          }
        }
      }
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({
      id: "local_sub_2",
      status: "pending"
    } as never);

    const response = await POST(
      new Request("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}"
      })
    );

    expect(response.status).toBe(200);
    expect(updateSubscription).toHaveBeenCalledWith("local_sub_2", { status: "past_due" });
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
