import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/client", () => ({
  resolvePriceId: vi.fn((tier: string, period: string) => `price_${tier}_${period}`),
  createCheckoutSession: vi.fn()
}));

import {
  createAdminResubscribeCheckout,
  createResubscribeCheckoutSession
} from "@/lib/billing/resubscribe-checkout";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { BusinessRow } from "@/lib/db/businesses";

const BIZ = "6cc2d7ba-a007-49d4-93a4-586967e147f1";
const NOW = new Date("2026-09-19T12:00:00.000Z");

function business(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: BIZ,
    name: "Scar Fairy",
    owner_email: "selena@example.com",
    tier: "standard",
    status: "active",
    ...overrides
  } as BusinessRow;
}

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-row-1",
    business_id: BIZ,
    stripe_customer_id: "cus_Uu3hTLCgROTtbP",
    stripe_subscription_id: "sub_1TuFa5Fv205jOP2fl1ze0t2n",
    tier: "standard",
    status: "canceled",
    billing_period: "monthly",
    customer_profile_id: "prof-1",
    cancel_reason: "payment_failed",
    canceled_at: "2026-09-17T01:04:59.000Z",
    grace_ends_at: "2026-10-17T01:04:59.000Z",
    wiped_at: null,
    ...overrides
  } as SubscriptionRow;
}

describe("createResubscribeCheckoutSession", () => {
  it("attaches the existing Stripe customer and resubscribe metadata, no intro coupon", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_resub",
      url: "https://checkout.stripe.com/resub"
    });
    const session = await createResubscribeCheckoutSession(
      {
        businessId: BIZ,
        ownerEmail: "selena@example.com",
        tier: "standard",
        billingPeriod: "monthly",
        userId: "user_1",
        customerProfileId: "prof-1",
        stripeCustomerId: "cus_Uu3hTLCgROTtbP",
        appUrl: "https://www.example.com"
      },
      { createSession }
    );
    expect(session.url).toBe("https://checkout.stripe.com/resub");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        priceId: "price_standard_monthly",
        customer: "cus_Uu3hTLCgROTtbP",
        metadata: expect.objectContaining({
          businessId: BIZ,
          tier: "standard",
          billingPeriod: "monthly",
          lifecycleAction: "resubscribe",
          customerProfileId: "prof-1",
          userId: "user_1"
        })
      })
    );
    const params = createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("customerEmail");
    expect(params.discountCouponId).toBeUndefined();
    expect(params.oneTimeCarrierFeeCents).toBeUndefined();
  });

  it("falls back to customerEmail when there is no Stripe customer id", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "cs_2", url: "https://checkout.stripe.com/x" });
    await createResubscribeCheckoutSession(
      {
        businessId: BIZ,
        ownerEmail: "selena@example.com",
        tier: "starter",
        billingPeriod: "annual",
        userId: BIZ,
        customerProfileId: null,
        stripeCustomerId: null,
        appUrl: "https://www.example.com"
      },
      { createSession }
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: "selena@example.com" })
    );
    expect(createSession.mock.calls[0][0]).not.toHaveProperty("customer");
    expect(createSession.mock.calls[0][0].metadata).not.toHaveProperty("customerProfileId");
  });
});

describe("createAdminResubscribeCheckout", () => {
  it("mints a Standard monthly link for a canceled-in-grace tenant", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_admin",
      url: "https://checkout.stripe.com/admin"
    });
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () => subscription()),
        createSession,
        appUrl: "https://www.example.com"
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("standard");
    expect(result.billingPeriod).toBe("monthly");
    expect(result.ownerEmail).toBe("selena@example.com");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: "cus_Uu3hTLCgROTtbP",
        tier: "standard",
        billingPeriod: "monthly"
      })
    );
  });

  it("defaults an enterprise canceled row to Standard", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_ent",
      url: "https://checkout.stripe.com/ent"
    });
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business({ tier: "enterprise" })),
        getSubscriptionRow: vi.fn(async () => subscription({ tier: "enterprise" })),
        createSession,
        appUrl: "https://www.example.com"
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("standard");
  });

  it("refuses when the business is missing", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => null),
        getSubscriptionRow: vi.fn(async () => subscription()),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, refusal: "business_not_found" }));
  });

  it("refuses when there is no subscription row", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () => null),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, refusal: "subscription_not_found" })
    );
  });

  it("refuses outside the grace window", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () =>
          subscription({
            grace_ends_at: "2026-09-01T00:00:00.000Z",
            status: "canceled"
          })
        ),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, refusal: "subscription_not_in_grace" })
    );
  });

  it("refuses without an owner email", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business({ owner_email: "   " })),
        getSubscriptionRow: vi.fn(async () => subscription()),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, refusal: "no_owner_email" }));
  });

  it("refuses when owner_email is missing entirely", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business({ owner_email: null as unknown as string })),
        getSubscriptionRow: vi.fn(async () => subscription()),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, refusal: "no_owner_email" }));
  });

  it("refuses an unsupported billing period from a corrupt row", async () => {
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () =>
          subscription({ billing_period: "weekly" as never })
        ),
        createSession: vi.fn()
      }
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: false, refusal: "unsupported_reactivation_period" })
    );
  });

  it("defaults now and appUrl when omitted", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_now",
      url: "https://checkout.stripe.com/now"
    });
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () =>
          subscription({ grace_ends_at: "2099-01-01T00:00:00.000Z" })
        ),
        createSession
      }
    );
    expect(result.ok).toBe(true);
  });

  it("defaults a null billing period to monthly", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_month",
      url: "https://checkout.stripe.com/month"
    });
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () =>
          subscription({ billing_period: null as unknown as SubscriptionRow["billing_period"] })
        ),
        createSession,
        appUrl: "https://www.example.com"
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.billingPeriod).toBe("monthly");
  });

  it("honors an explicit starter / annual override", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_over",
      url: "https://checkout.stripe.com/over"
    });
    const result = await createAdminResubscribeCheckout(
      { businessId: BIZ, tier: "starter", billingPeriod: "annual", now: NOW },
      {
        getBusinessRow: vi.fn(async () => business()),
        getSubscriptionRow: vi.fn(async () => subscription()),
        createSession,
        appUrl: "https://www.example.com"
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("starter");
    expect(result.billingPeriod).toBe("annual");
  });
});
