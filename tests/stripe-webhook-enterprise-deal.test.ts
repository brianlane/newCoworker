/**
 * Enterprise-deal activation path of the Stripe webhook
 * (`checkoutKind: "enterprise_deal"` subscription-mode sessions), plus the
 * deal-cancel mirror on customer.subscription.deleted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStripeRetrieve } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn().mockResolvedValue({
    current_period_start: 1700000000,
    current_period_end: 1702678400
  })
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (cb: () => void | Promise<void>) => void cb };
});

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
    createSubscription: vi.fn(),
    getSubscription: vi.fn(),
    getSubscriptionByStripeSubscriptionId: vi.fn(),
    updateSubscription: vi.fn()
  };
});

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  recordWhiteGlovePurchase: vi.fn(),
  setBusinessCustomerProfile: vi.fn()
}));

vi.mock("@/lib/db/white-glove-offers", () => ({
  getWhiteGloveOffer: vi.fn(),
  markWhiteGloveOfferPaid: vi.fn(),
  extendPrioritySupport: vi.fn(),
  attachPaidProspectOfferToBusinessByEmail: vi.fn()
}));

vi.mock("@/lib/db/enterprise-deals", () => ({
  getEnterpriseDeal: vi.fn(),
  markEnterpriseDealActive: vi.fn(),
  markEnterpriseDealCanceledByStripeSubscriptionId: vi.fn()
}));

vi.mock("@/lib/billing/change-plan-orchestrator", () => ({
  cancelStripeSubscriptionSafely: vi.fn().mockResolvedValue(undefined),
  runChangePlanFromCheckout: vi.fn(),
  runResubscribeFromCheckout: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-loader", () => ({
  loadLifecycleContextForBusiness: vi.fn()
}));

vi.mock("@/lib/billing/lifecycle-executor", () => ({
  executeLifecyclePlan: vi.fn(),
  executeLifecyclePlanFastPhase: vi.fn(),
  executeLifecyclePlanSlowPhase: vi.fn()
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockResolvedValue({ rpc: vi.fn() })
}));

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/webhooks/stripe/route";
import { verifyWebhook } from "@/lib/stripe/client";
import {
  createSubscription,
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  updateSubscription
} from "@/lib/db/subscriptions";
import {
  getEnterpriseDeal,
  markEnterpriseDealActive,
  markEnterpriseDealCanceledByStripeSubscriptionId
} from "@/lib/db/enterprise-deals";
import { cancelStripeSubscriptionSafely } from "@/lib/billing/change-plan-orchestrator";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";

const DEAL = {
  id: DEAL_ID,
  business_id: BIZ_ID,
  setup_cents: 82_500,
  monthly_cents: 49_500,
  status: "open",
  created_by: "admin@example.com",
  created_at: "2026-07-08T00:00:00Z",
  activated_at: null,
  stripe_session_id: null,
  stripe_subscription_id: null,
  pay_token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
};

/** The Stripe-less active row create-client writes for enterprise accounts. */
const STRIPELESS_ROW = {
  id: "row-1",
  business_id: BIZ_ID,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  tier: "enterprise",
  status: "active",
  billing_period: null,
  renewal_at: null,
  commitment_months: null,
  grace_ends_at: null,
  wiped_at: null,
  canceled_at: null,
  cancel_reason: null,
  customer_profile_id: null,
  cancel_at_period_end: false,
  contract_auto_renew: false
};

function checkoutCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_ent_1",
        mode: "subscription",
        created: 1767225600, // 2026-01-01T00:00:00Z
        customer: "cus_ent_1",
        subscription: "sub_ent_1",
        metadata: {
          checkoutKind: "enterprise_deal",
          enterpriseDealId: DEAL_ID,
          businessId: BIZ_ID,
          tier: "enterprise"
        },
        ...overrides
      }
    }
  };
}

async function postEvent(event: unknown) {
  vi.mocked(verifyWebhook).mockReturnValue(event as never);
  return POST(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "sig" },
      body: "{}"
    })
  );
}

describe("stripe webhook: enterprise deal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeRetrieve.mockResolvedValue({
      current_period_start: 1700000000,
      current_period_end: 1702678400
    });
    vi.mocked(getEnterpriseDeal).mockResolvedValue(DEAL as never);
    vi.mocked(markEnterpriseDealActive).mockResolvedValue("active");
    vi.mocked(getSubscription).mockResolvedValue(STRIPELESS_ROW as never);
  });

  it("activates the deal and wires the Stripe-less subscription row", async () => {
    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(markEnterpriseDealActive).toHaveBeenCalledWith(DEAL_ID, {
      activatedAt: new Date(1767225600 * 1000),
      stripeSessionId: "cs_ent_1",
      stripeSubscriptionId: "sub_ent_1"
    });
    expect(updateSubscription).toHaveBeenCalledWith("row-1", {
      status: "active",
      tier: "enterprise",
      billing_period: "monthly",
      commitment_months: 1,
      stripe_customer_id: "cus_ent_1",
      stripe_subscription_id: "sub_ent_1",
      stripe_current_period_start: new Date(1700000000 * 1000).toISOString(),
      stripe_current_period_end: new Date(1702678400 * 1000).toISOString(),
      stripe_subscription_cached_at: expect.any(String)
    });
    // Deliberately NOT part of the enterprise path:
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
    expect(cancelStripeSubscriptionSafely).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("creates a subscription row when none exists (defensive)", async () => {
    vi.mocked(getSubscription).mockResolvedValue(null);

    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        tier: "enterprise",
        status: "active",
        stripe_customer_id: "cus_ent_1",
        stripe_subscription_id: "sub_ent_1",
        billing_period: "monthly",
        commitment_months: 1
      })
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("cancels the duplicate Stripe subscription when a second session activates an already-active deal", async () => {
    vi.mocked(markEnterpriseDealActive).mockResolvedValue("duplicate_session");

    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(cancelStripeSubscriptionSafely).toHaveBeenCalledWith("sub_ent_1", BIZ_ID);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("refuses activation when the row is already linked to a DIFFERENT live Stripe sub", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      ...STRIPELESS_ROW,
      stripe_subscription_id: "sub_other"
    } as never);

    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(cancelStripeSubscriptionSafely).toHaveBeenCalledWith("sub_ent_1", BIZ_ID);
    expect(markEnterpriseDealActive).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("refuses activation on a canceled local row (must go through reactivation)", async () => {
    vi.mocked(getSubscription).mockResolvedValue({
      ...STRIPELESS_ROW,
      status: "canceled",
      grace_ends_at: "2026-08-01T00:00:00Z"
    } as never);

    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(cancelStripeSubscriptionSafely).toHaveBeenCalledWith("sub_ent_1", BIZ_ID);
    expect(markEnterpriseDealActive).not.toHaveBeenCalled();
  });

  it("ignores sessions whose deal is unknown or mismatched", async () => {
    vi.mocked(getEnterpriseDeal).mockResolvedValue(null);

    const response = await postEvent(checkoutCompletedEvent());

    expect(response.status).toBe(200);
    expect(markEnterpriseDealActive).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();

    // Mismatched metadata businessId is refused even when the deal exists.
    vi.mocked(getEnterpriseDeal).mockResolvedValue({
      ...DEAL,
      business_id: "99999999-9999-4999-8999-999999999999"
    } as never);
    await postEvent(checkoutCompletedEvent());
    expect(markEnterpriseDealActive).not.toHaveBeenCalled();
  });

  it("flips the deal to canceled when the Stripe subscription is deleted", async () => {
    vi.mocked(markEnterpriseDealCanceledByStripeSubscriptionId).mockResolvedValue(true);
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null);

    const response = await postEvent({
      id: "evt_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_ent_1", metadata: {} } }
    });

    expect(response.status).toBe(200);
    expect(markEnterpriseDealCanceledByStripeSubscriptionId).toHaveBeenCalledWith("sub_ent_1");
  });

  it("keeps the webhook 200 when the deal-cancel mirror fails (best-effort)", async () => {
    vi.mocked(markEnterpriseDealCanceledByStripeSubscriptionId).mockRejectedValue(
      new Error("db down")
    );
    vi.mocked(getSubscriptionByStripeSubscriptionId).mockResolvedValue(null);

    const response = await postEvent({
      id: "evt_3",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_ent_1", metadata: {} } }
    });

    expect(response.status).toBe(200);
  });
});
