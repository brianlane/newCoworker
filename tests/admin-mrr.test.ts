import { describe, expect, it } from "vitest";

import { computeDayCurrentMrr, type MrrSubscriptionInput } from "@/lib/admin/mrr";
import { getPeriodPricing } from "@/lib/plans/tier";

const NOW = new Date("2026-07-10T12:00:00Z");

function sub(overrides: Partial<MrrSubscriptionInput> = {}): MrrSubscriptionInput {
  return {
    tier: "standard",
    status: "active",
    stripe_subscription_id: "sub_123",
    billing_period: "biennial",
    renewal_at: "2028-06-01T00:00:00Z",
    stripe_current_period_start: "2026-06-01T00:00:00Z",
    stripe_current_period_end: "2028-06-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    ...overrides
  };
}

describe("computeDayCurrentMrr", () => {
  it("prices an in-term subscription at the contract rate", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub()],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(getPeriodPricing("standard", "biennial").monthlyCents);
    expect(result.totalCents).toBe(9900);
    expect(result.countedSubscriptions).toBe(1);
  });

  it("prices a rolled-over term subscription at the renewal rate (past renewal_at + monthly Stripe period)", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: "2026-06-15T00:00:00Z",
          stripe_current_period_end: "2026-07-15T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(
      getPeriodPricing("standard", "biennial").renewalMonthlyCents
    );
    expect(result.totalCents).toBe(18_900);
  });

  it("keeps the contract rate past renewal_at while the Stripe period is still term-length (auto-renewed contract)", () => {
    // renewal_at is never advanced on an auto-renewed full term, the
    // 24-month Stripe period is what says "still committed".
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: "2026-06-15T00:00:00Z",
          stripe_current_period_end: "2028-06-15T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(9900);
  });

  it("fails toward the contract rate when the Stripe period cache is missing (same direction as the billing page)", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          renewal_at: "2026-06-15T00:00:00Z",
          stripe_current_period_start: null,
          stripe_current_period_end: null
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(9900);
  });

  it("prices a monthly plan at the intro rate inside its first month, renewal rate after", () => {
    // renewal_at stamped at checkout (created + 1 month) still ahead of NOW.
    const inIntro = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: "2026-08-01T00:00:00Z",
          created_at: "2026-07-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(inIntro.subscriptionCents).toBe(getPeriodPricing("starter", "monthly").monthlyCents);

    // Missing renewal_at falls back to created_at + 1 month; created two
    // months ago → ongoing renewal rate.
    const ongoing = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: null,
          created_at: "2026-05-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(ongoing.subscriptionCents).toBe(
      getPeriodPricing("starter", "monthly").renewalMonthlyCents
    );

    // Malformed renewal_at takes the same created_at fallback, created this
    // month → still intro.
    const malformed = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: "not-a-date",
          created_at: "2026-07-01T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(malformed.subscriptionCents).toBe(getPeriodPricing("starter", "monthly").monthlyCents);
  });

  it("clamps month-end anchors for the monthly intro fallback (Jan 31 + 1mo = Feb 28, not Mar 3)", () => {
    // Naive month addition would put the intro end at Mar 3 and misclassify
    // Mar 1 as intro-priced; clamped math ends the intro month on Feb 28.
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          tier: "starter",
          billing_period: "monthly",
          renewal_at: null,
          created_at: "2026-01-31T00:00:00Z"
        })
      ],
      enterpriseDeals: [],
      now: new Date("2026-03-01T00:00:00Z")
    });
    expect(result.subscriptionCents).toBe(
      getPeriodPricing("starter", "monthly").renewalMonthlyCents
    );
  });

  it("treats a null billing_period as monthly", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ billing_period: null, renewal_at: null, created_at: "2026-07-05T00:00:00Z" })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(getPeriodPricing("standard", "monthly").monthlyCents);
  });

  it("excludes non-active and Stripe-less subscriptions", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ status: "pending" }),
        sub({ status: "canceled" }),
        sub({ stripe_subscription_id: null })
      ],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(0);
    expect(result.countedSubscriptions).toBe(0);
  });

  it("prices enterprise from active deals, never the tier table", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub({ tier: "enterprise" })],
      enterpriseDeals: [{ monthly_cents: 49_500 }, { monthly_cents: 120_000 }],
      now: NOW
    });
    expect(result.subscriptionCents).toBe(0);
    expect(result.enterpriseDealCents).toBe(169_500);
    expect(result.totalCents).toBe(169_500);
  });

  it("defaults `now` to the current time", () => {
    // Term end far in the future so the assertion is stable under real time.
    const result = computeDayCurrentMrr({
      subscriptions: [sub({ renewal_at: "2099-01-01T00:00:00Z" })],
      enterpriseDeals: []
    });
    expect(result.totalCents).toBe(9900);
  });

  it("splits refund-exposed revenue out of the committed number", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub({ refund_exposed: true }), sub({ refund_exposed: false }), sub()],
      enterpriseDeals: [{ monthly_cents: 49_500 }],
      now: NOW
    });
    expect(result.totalCents).toBe(3 * 9900 + 49_500);
    expect(result.refundExposedCents).toBe(9900);
    expect(result.committedCents).toBe(2 * 9900 + 49_500);
  });

  it("never counts enterprise deals or excluded subscriptions as refund-exposed", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ tier: "enterprise", refund_exposed: true }),
        sub({ status: "pending", refund_exposed: true }),
        sub({ stripe_subscription_id: null, refund_exposed: true })
      ],
      enterpriseDeals: [{ monthly_cents: 49_500 }],
      now: NOW
    });
    expect(result.refundExposedCents).toBe(0);
    expect(result.committedCents).toBe(result.totalCents);
  });

  it("treats subscriptions without the refund_exposed flag as committed", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [sub()],
      enterpriseDeals: [],
      now: NOW
    });
    expect(result.refundExposedCents).toBe(0);
    expect(result.committedCents).toBe(result.totalCents);
  });
});

describe("computeDayCurrentMrr, recurring pack add-ons", () => {
  const options = [
    { category: "voice" as const, id: "min_30", label: "30 minutes", listPriceCents: 6000 },
    { category: "sms" as const, id: "texts_500", label: "500 texts", listPriceCents: 2000 }
  ];

  /**
   * #1026 made packs recurring subscription items that bill every cycle, but
   * the MRR tile still derived every subscription's rate from
   * getPeriodPricing alone, so real recurring pack revenue was invisible on
   * the exact tile #1015 relabeled. The mirror (#1073) put the packs on the
   * local row; price them at the same discounted monthly the invoice bills.
   */
  it("adds mirrored pack revenue at the period's discounted monthly rate", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          membership_pack_addons: { addonVoice: "min_30:2:1800", addonSms: "texts_500:1:500" }
        })
      ],
      enterpriseDeals: [],
      packAddonOptions: options,
      now: NOW
    });
    // Biennial pack discount is 20%: 2 x $48 + 1 x $16 on top of the $99 plan.
    expect(result.subscriptionCents).toBe(9900 + 2 * 4800 + 1600);
  });

  it("keeps pack revenue out of refund exposure (packs are non-refundable)", () => {
    // The refund executor carves pack lines out of the money-back (Aug 2026),
    // so only the plan rate can actually leave through a refund. Pack cents
    // still count in the totals: they do recur.
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({
          refund_exposed: true,
          membership_pack_addons: { addonVoice: "min_30:1:1800" }
        })
      ],
      enterpriseDeals: [],
      packAddonOptions: options,
      now: NOW
    });
    expect(result.subscriptionCents).toBe(9900 + 4800);
    expect(result.refundExposedCents).toBe(9900);
    expect(result.committedCents).toBe(4800);
  });

  describe("admin membership discount", () => {
    it("takes a live percentage discount off the plan rate", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            discount_coupon_id: "co_1",
            discount_percent_off: 30,
            discount_duration: "forever"
          })
        ],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.subscriptionCents).toBe(Math.round(9900 * 0.7));
    });

    it("takes a live amount discount off the plan rate", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            discount_coupon_id: "co_1",
            discount_amount_off_cents: 4000,
            discount_duration: "forever"
          })
        ],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.subscriptionCents).toBe(9900 - 4000);
    });

    it("discounts the plan line only, never the packs riding beside it", () => {
      // The coupon is scoped to the plan product at Stripe, so a discounted
      // tenant still pays full freight on their packs. This number has to
      // agree with the invoice.
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            membership_pack_addons: { addonVoice: "min_30:1:1800" },
            discount_coupon_id: "co_1",
            discount_percent_off: 50,
            discount_duration: "forever"
          })
        ],
        enterpriseDeals: [],
        packAddonOptions: options,
        now: NOW
      });
      expect(result.subscriptionCents).toBe(Math.round(9900 * 0.5) + 4800);
    });

    it("carries the discount into the refund-exposed figure too", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            refund_exposed: true,
            discount_coupon_id: "co_1",
            discount_percent_off: 30,
            discount_duration: "forever"
          })
        ],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.refundExposedCents).toBe(Math.round(9900 * 0.7));
      expect(result.committedCents).toBe(0);
    });

    it("ignores a one-off discount, same treatment as the monthly intro coupon", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            discount_coupon_id: "co_1",
            discount_percent_off: 30,
            discount_duration: "once"
          })
        ],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.subscriptionCents).toBe(9900);
    });

    it("ignores a repeating discount that has already run out", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [
          sub({
            discount_coupon_id: "co_1",
            discount_percent_off: 30,
            discount_duration: "repeating",
            discount_ends_at: "2026-01-01T00:00:00Z"
          })
        ],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.subscriptionCents).toBe(9900);
    });

    it("prices a row that predates the discount columns at full rate", () => {
      const result = computeDayCurrentMrr({
        subscriptions: [sub()],
        enterpriseDeals: [],
        now: NOW
      });
      expect(result.subscriptionCents).toBe(9900);
    });
  });

  it("ignores junk mirrors and unknown pack ids rather than erroring the tile", () => {
    const result = computeDayCurrentMrr({
      subscriptions: [
        sub({ membership_pack_addons: "nonsense" as never }),
        sub({ membership_pack_addons: { addonVoice: "retired_pack:3:1800" } })
      ],
      enterpriseDeals: [],
      packAddonOptions: options,
      now: NOW
    });
    expect(result.subscriptionCents).toBe(2 * 9900);
  });
});
