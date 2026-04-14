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

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
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
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { logger } from "@/lib/logger";

describe("stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(updateSubscription).toHaveBeenCalledWith("local_sub_3", { status: "active" });
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
