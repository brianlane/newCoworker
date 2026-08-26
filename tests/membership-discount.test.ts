import { describe, expect, it } from "vitest";
import {
  applyMembershipDiscountToCents,
  buildApplyDiscountParams,
  buildDiscountCouponParams,
  buildRemoveDiscountParams,
  describeMembershipDiscount,
  describeMembershipDiscountStripeError,
  discountStateFromStripeSubscription,
  DISCOUNT_AMOUNT_MAX_CENTS,
  DISCOUNT_MAX_MONTHS,
  hasMembershipDiscount,
  membershipDiscountReducesMrr,
  NO_MEMBERSHIP_DISCOUNT,
  resolveMembershipDiscount,
  resolveMembershipDiscountLabel,
  toMembershipDiscountState,
  type MembershipDiscountState
} from "@/lib/billing/membership-discount";

const NOW = new Date("2026-08-25T00:00:00.000Z");

function state(overrides: Partial<MembershipDiscountState> = {}): MembershipDiscountState {
  return { ...NO_MEMBERSHIP_DISCOUNT, ...overrides };
}

/** A fully expanded Stripe subscription discount, the shape the route asks for. */
function stripeSub(coupon: Record<string, unknown>, discount: Record<string, unknown> = {}) {
  return {
    discounts: [
      { id: "di_1", start: 1_787_616_000, end: null, source: { type: "coupon", coupon }, ...discount }
    ]
  };
}

describe("resolveMembershipDiscount", () => {
  it("accepts a percentage and normalizes the month count away", () => {
    const result = resolveMembershipDiscount({ percentOff: 30, duration: "forever" });
    expect(result).toEqual({
      ok: true,
      value: { percentOff: 30, amountOffCents: null, duration: "forever", durationInMonths: null }
    });
  });

  it("converts whole dollars to cents", () => {
    const result = resolveMembershipDiscount({ amountOffUsd: 40.5, duration: "once" });
    expect(result).toMatchObject({ ok: true, value: { amountOffCents: 4050, percentOff: null } });
  });

  it("keeps the month count for a repeating discount", () => {
    const result = resolveMembershipDiscount({
      percentOff: 25,
      duration: "repeating",
      durationInMonths: 6
    });
    expect(result).toMatchObject({ ok: true, value: { duration: "repeating", durationInMonths: 6 } });
  });

  it("refuses a submission with neither shape", () => {
    expect(resolveMembershipDiscount({ duration: "once" })).toEqual({
      ok: false,
      message: "Set a percentage off or an amount off"
    });
  });

  it("refuses a submission with both shapes rather than guessing which was meant", () => {
    const result = resolveMembershipDiscount({
      percentOff: 10,
      amountOffUsd: 10,
      duration: "once"
    });
    expect(result).toEqual({
      ok: false,
      message: "Set only one of a percentage off or an amount off"
    });
  });

  it.each([0, 101, Number.NaN])("refuses an out-of-range percentage: %s", (percentOff) => {
    const result = resolveMembershipDiscount({ percentOff, duration: "once" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("percentage off must be between");
  });

  it.each([0.5, DISCOUNT_AMOUNT_MAX_CENTS / 100 + 1, Number.NaN])(
    "refuses an out-of-range amount: %s",
    (amountOffUsd) => {
      const result = resolveMembershipDiscount({ amountOffUsd, duration: "once" });
      expect(result).toMatchObject({ ok: false });
      expect((result as { message: string }).message).toContain("amount off must be between");
    }
  );

  it.each([null, 0, DISCOUNT_MAX_MONTHS + 1, 2.5])(
    "refuses a repeating discount with a bad month count: %s",
    (durationInMonths) => {
      const result = resolveMembershipDiscount({
        percentOff: 10,
        duration: "repeating",
        durationInMonths
      });
      expect(result).toMatchObject({ ok: false });
      expect((result as { message: string }).message).toContain("whole number of months");
    }
  );

  it("refuses a month count on a duration that does not repeat", () => {
    const result = resolveMembershipDiscount({
      percentOff: 10,
      duration: "forever",
      durationInMonths: 3
    });
    expect(result).toEqual({
      ok: false,
      message: "Only a repeating discount takes a number of months"
    });
  });
});

describe("resolveMembershipDiscountLabel", () => {
  it("trims the operator's reason", () => {
    expect(resolveMembershipDiscountLabel("  Retention credit  ")).toEqual({
      ok: true,
      value: "Retention credit"
    });
  });

  it.each(["", "  ", "ab", "x".repeat(121)])("refuses a bad label: %s", (label) => {
    expect(resolveMembershipDiscountLabel(label)).toMatchObject({ ok: false });
  });
});

describe("buildDiscountCouponParams", () => {
  it("scopes a percentage coupon to the products it was handed", () => {
    expect(
      buildDiscountCouponParams({
        label: "Retention",
        discount: {
          percentOff: 30,
          amountOffCents: null,
          duration: "forever",
          durationInMonths: null
        },
        productIds: ["prod_plan"],
        metadata: { businessId: "biz-1" }
      })
    ).toEqual({
      name: "Retention",
      duration: "forever",
      percent_off: 30,
      applies_to: { products: ["prod_plan"] },
      metadata: { businessId: "biz-1" }
    });
  });

  it("sends an amount coupon in USD with its month count", () => {
    expect(
      buildDiscountCouponParams({
        label: "Outage credit",
        discount: {
          percentOff: null,
          amountOffCents: 4000,
          duration: "repeating",
          durationInMonths: 3
        },
        productIds: ["prod_plan"],
        metadata: {}
      })
    ).toEqual({
      name: "Outage credit",
      duration: "repeating",
      duration_in_months: 3,
      amount_off: 4000,
      currency: "usd",
      applies_to: { products: ["prod_plan"] },
      metadata: {}
    });
  });

  it("falls back to a zero amount when neither shape survived (defensive)", () => {
    expect(
      buildDiscountCouponParams({
        label: "Broken",
        discount: {
          percentOff: null,
          amountOffCents: null,
          duration: "once",
          durationInMonths: null
        },
        productIds: [],
        metadata: {}
      })
    ).toMatchObject({ amount_off: 0, currency: "usd" });
  });
});

describe("apply / remove payloads", () => {
  it("attaches one coupon and expands enough to mirror the answer", () => {
    expect(buildApplyDiscountParams("co_1")).toEqual({
      discounts: [{ coupon: "co_1" }],
      expand: ["discounts.source.coupon"]
    });
  });

  it("clears with the EMPTY STRING, not an empty array", () => {
    const params = buildRemoveDiscountParams();
    // Stripe reads [] as "leave discounts unchanged" and only "" as "remove
    // them", so an empty array here would make removal a silent no-op while
    // the route reported success.
    expect(params.discounts).toBe("");
    expect(params.discounts).not.toEqual([]);
  });
});

describe("discountStateFromStripeSubscription", () => {
  it("reads a fully expanded percentage discount", () => {
    expect(
      discountStateFromStripeSubscription(
        stripeSub({
          id: "co_1",
          name: "Retention",
          percent_off: 30,
          amount_off: null,
          duration: "forever",
          duration_in_months: null
        })
      )
    ).toEqual({
      discount_coupon_id: "co_1",
      discount_name: "Retention",
      discount_percent_off: 30,
      discount_amount_off_cents: null,
      discount_duration: "forever",
      discount_duration_in_months: null,
      discount_started_at: "2026-08-25T00:00:00.000Z",
      discount_ends_at: null
    });
  });

  it("reads a repeating amount discount, including when it ends", () => {
    expect(
      discountStateFromStripeSubscription(
        stripeSub(
          {
            id: "co_2",
            name: null,
            percent_off: null,
            amount_off: 4000,
            duration: "repeating",
            duration_in_months: 3
          },
          { end: 1_795_478_400 }
        )
      )
    ).toMatchObject({
      discount_amount_off_cents: 4000,
      discount_duration_in_months: 3,
      discount_name: null,
      discount_ends_at: "2026-11-24T00:00:00.000Z"
    });
  });

  it("drops a month count Stripe reports on a non-repeating coupon", () => {
    const read = discountStateFromStripeSubscription(
      stripeSub({
        id: "co_3",
        name: "x",
        percent_off: 10,
        amount_off: null,
        duration: "once",
        duration_in_months: 4
      })
    );
    expect(read?.discount_duration_in_months).toBeNull();
  });

  it("clears the mirror on an empty array, which is Stripe saying there is none", () => {
    expect(discountStateFromStripeSubscription({ discounts: [] })).toEqual(NO_MEMBERSHIP_DISCOUNT);
  });

  it.each([
    ["a webhook payload, where discounts are bare ids", { discounts: ["di_1"] }],
    ["a discount with no expanded source", { discounts: [{ id: "di_1" }] }],
    ["a source whose coupon is still an id", { discounts: [{ source: { coupon: "co_1" } }] }],
    [
      "a coupon with no id",
      stripeSub({ name: "x", percent_off: 10, duration: "once", duration_in_months: null })
    ],
    [
      "a coupon with an unknown duration",
      stripeSub({ id: "co_1", name: "x", percent_off: 10, duration: "annually" })
    ],
    ["no discounts field at all", { id: "sub_1" }],
    ["a non-object", null]
  ])("returns null (leave the mirror alone) for %s", (_label, input) => {
    expect(discountStateFromStripeSubscription(input)).toBeNull();
  });

  it("never lets an unreadable payload wipe a live discount", () => {
    // The regression this guards: customer.subscription.updated cannot expand
    // `discounts`, so folding "unreadable" into "no discount" would clear the
    // mirror of every discounted tenant on any unrelated subscription edit.
    const webhookPayload = { discounts: ["di_1"], status: "active" };
    expect(discountStateFromStripeSubscription(webhookPayload)).not.toEqual(
      NO_MEMBERSHIP_DISCOUNT
    );
    expect(discountStateFromStripeSubscription(webhookPayload)).toBeNull();
  });
});

describe("toMembershipDiscountState", () => {
  it("coalesces undefined fields to null so they cannot reach the money math", () => {
    expect(toMembershipDiscountState({ discount_coupon_id: undefined })).toEqual(
      NO_MEMBERSHIP_DISCOUNT
    );
  });

  it.each([null, undefined])("treats %s as no discount", (input) => {
    expect(toMembershipDiscountState(input)).toEqual(NO_MEMBERSHIP_DISCOUNT);
  });

  it("keeps the fields a real row carries", () => {
    expect(
      toMembershipDiscountState({ discount_coupon_id: "co_1", discount_percent_off: 30 })
    ).toMatchObject({ discount_coupon_id: "co_1", discount_percent_off: 30 });
  });
});

describe("hasMembershipDiscount", () => {
  it.each([
    ["a coupon id", "co_1", true],
    ["null", null, false],
    ["an empty string", "", false],
    ["undefined from a pre-feature row", undefined as unknown as null, false]
  ])("%s reads as %s", (_label, discount_coupon_id, expected) => {
    expect(hasMembershipDiscount({ discount_coupon_id })).toBe(expected);
  });
});

describe("describeMembershipDiscount", () => {
  it.each([
    [
      "30% off, every invoice",
      { discount_percent_off: 30, discount_duration: "forever" as const }
    ],
    [
      "30% off for 6 months",
      {
        discount_percent_off: 30,
        discount_duration: "repeating" as const,
        discount_duration_in_months: 6
      }
    ],
    [
      "30% off for 1 month",
      {
        discount_percent_off: 30,
        discount_duration: "repeating" as const,
        discount_duration_in_months: 1
      }
    ],
    [
      "30% off on the next invoice",
      { discount_percent_off: 30, discount_duration: "once" as const }
    ],
    [
      "$40 off on the next invoice",
      { discount_amount_off_cents: 4000, discount_duration: "once" as const }
    ]
  ])("renders %s", (expected, overrides) => {
    expect(describeMembershipDiscount(state({ discount_coupon_id: "co_1", ...overrides }))).toBe(
      expected
    );
  });

  it("falls back to a bare word when a live coupon carries neither value", () => {
    expect(
      describeMembershipDiscount(
        state({ discount_coupon_id: "co_1", discount_duration: "forever" })
      )
    ).toBe("Discount, every invoice");
  });

  it("defaults a repeating discount with no month count to zero months", () => {
    expect(
      describeMembershipDiscount(
        state({
          discount_coupon_id: "co_1",
          discount_percent_off: 10,
          discount_duration: "repeating"
        })
      )
    ).toBe("10% off for 0 months");
  });

  it("renders nothing when no discount is live", () => {
    expect(describeMembershipDiscount(NO_MEMBERSHIP_DISCOUNT)).toBeNull();
  });
});

describe("membershipDiscountReducesMrr", () => {
  it("counts a forever discount", () => {
    expect(
      membershipDiscountReducesMrr(
        state({ discount_coupon_id: "co_1", discount_duration: "forever" }),
        NOW
      )
    ).toBe(true);
  });

  it("excludes a one-off discount, same treatment as the monthly intro coupon", () => {
    expect(
      membershipDiscountReducesMrr(
        state({ discount_coupon_id: "co_1", discount_duration: "once" }),
        NOW
      )
    ).toBe(false);
  });

  it("counts a repeating discount that is still running", () => {
    expect(
      membershipDiscountReducesMrr(
        state({
          discount_coupon_id: "co_1",
          discount_duration: "repeating",
          discount_ends_at: "2026-12-01T00:00:00.000Z"
        }),
        NOW
      )
    ).toBe(true);
  });

  it("stops counting a repeating discount that has run out", () => {
    expect(
      membershipDiscountReducesMrr(
        state({
          discount_coupon_id: "co_1",
          discount_duration: "repeating",
          discount_ends_at: "2026-01-01T00:00:00.000Z"
        }),
        NOW
      )
    ).toBe(false);
  });

  it("counts a discount whose end date is unparseable rather than dropping it", () => {
    expect(
      membershipDiscountReducesMrr(
        state({
          discount_coupon_id: "co_1",
          discount_duration: "repeating",
          discount_ends_at: "not-a-date"
        }),
        NOW
      )
    ).toBe(true);
  });

  it("counts nothing when no discount is live", () => {
    expect(membershipDiscountReducesMrr(NO_MEMBERSHIP_DISCOUNT, NOW)).toBe(false);
  });
});

describe("applyMembershipDiscountToCents", () => {
  it("takes a percentage off", () => {
    expect(
      applyMembershipDiscountToCents(
        19500,
        state({
          discount_coupon_id: "co_1",
          discount_percent_off: 30,
          discount_duration: "forever"
        }),
        NOW
      )
    ).toBe(13650);
  });

  it("takes an amount off", () => {
    expect(
      applyMembershipDiscountToCents(
        19500,
        state({
          discount_coupon_id: "co_1",
          discount_amount_off_cents: 4000,
          discount_duration: "forever"
        }),
        NOW
      )
    ).toBe(15500);
  });

  it("clamps an amount larger than the plan at zero rather than going negative", () => {
    expect(
      applyMembershipDiscountToCents(
        1500,
        state({
          discount_coupon_id: "co_1",
          discount_amount_off_cents: 9900,
          discount_duration: "forever"
        }),
        NOW
      )
    ).toBe(0);
  });

  it("leaves the rate alone when nothing recurring is live", () => {
    expect(applyMembershipDiscountToCents(19500, NO_MEMBERSHIP_DISCOUNT, NOW)).toBe(19500);
  });

  it("leaves the rate alone for a live coupon whose value cannot be read", () => {
    expect(
      applyMembershipDiscountToCents(
        19500,
        state({ discount_coupon_id: "co_1", discount_duration: "forever" }),
        NOW
      )
    ).toBe(19500);
  });

  it("never returns NaN for a row whose fields arrived undefined", () => {
    const loose = { discount_coupon_id: "co_1", discount_duration: "forever" as const };
    expect(applyMembershipDiscountToCents(19500, loose, NOW)).toBe(19500);
  });
});

describe("describeMembershipDiscountStripeError", () => {
  it("translates the commitment-schedule rejection", () => {
    expect(
      describeMembershipDiscountStripeError("Cannot update a subscription with a schedule")
    ).toContain("commitment schedule");
  });

  it("passes anything else through untouched", () => {
    expect(describeMembershipDiscountStripeError("No such coupon: co_1")).toBe(
      "No such coupon: co_1"
    );
  });
});
