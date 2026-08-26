/**
 * Admin membership discount: taking a percentage or a dollar amount off a
 * membership that is ALREADY being billed.
 *
 * Why this is not `promotions`. That module prices a promo CODE, redeemed on a
 * Checkout Session at signup, and its row is shaped for that job: a
 * customer-facing string, a tier/period scope, a redemption cap, an
 * active-date window. None of those mean anything when an operator wants to
 * take 30% off one live subscription, and the two paths that touch an existing
 * subscription refuse discounts on purpose (change-plan and reactivate both
 * withhold the intro coupon so a serial canceler cannot keep re-earning it).
 * So this is its own lever: no code to type, no cap, one named tenant.
 *
 * This module is the pure part, matching admin-billing-controls: validation,
 * payload shaping, and reading Stripe's answer back. No network, no clock of
 * its own (callers pass `now`). src/lib/stripe/subscription-discount.ts makes
 * the calls; the route in src/app/api/admin/membership-discount does auth,
 * the DB mirror, and the audit line.
 *
 * Three Stripe facts drive the shapes below.
 *
 *   1. A coupon is IMMUTABLE. Its percent/amount/duration can never be edited,
 *      so "change the discount" is always mint-a-new-one plus attach, and the
 *      route overwrites rather than tries to patch.
 *   2. Clearing a subscription's discounts needs the EMPTY STRING. Stripe reads
 *      `discounts: []` as "leave them unchanged" and only `discounts: ""` as
 *      "remove them", so the obvious empty array silently does nothing. That
 *      trap is why removal has its own builder here rather than an inline
 *      literal at the call site.
 *   3. A discount never credits the cycle already paid. It lands on the NEXT
 *      invoice. Operator-facing copy has to say so, or a comp looks broken.
 */

import { formatPriceCents } from "@/lib/pricing";

/** Whole points, matching the admin form. Stripe itself allows fractions. */
export const DISCOUNT_PERCENT_MIN = 1;
export const DISCOUNT_PERCENT_MAX = 100;

/** Cents. A discount below a dollar is a fat finger, not a comp. */
export const DISCOUNT_AMOUNT_MIN_CENTS = 100;
export const DISCOUNT_AMOUNT_MAX_CENTS = 100_000_00;

/** Stripe's own ceiling on `duration_in_months` for a repeating coupon. */
export const DISCOUNT_MAX_MONTHS = 36;

export const DISCOUNT_LABEL_MIN_LENGTH = 3;
export const DISCOUNT_LABEL_MAX_LENGTH = 120;

export type MembershipDiscountDuration = "once" | "repeating" | "forever";

/** A resolved discount: exactly one of percent / amount, plus its duration. */
export type MembershipDiscount = {
  percentOff: number | null;
  amountOffCents: number | null;
  duration: MembershipDiscountDuration;
  durationInMonths: number | null;
};

export type MembershipDiscountInput = {
  percentOff?: number | null;
  /** Whole-dollar convenience from the admin form, converted here. */
  amountOffUsd?: number | null;
  duration: MembershipDiscountDuration;
  durationInMonths?: number | null;
};

export type MembershipDiscountResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Resolve an admin submission into the shape Stripe and the table CHECK both
 * expect, or a sentence explaining what is wrong with it.
 *
 * Deliberately strict about the pairings rather than silently picking one:
 * a form that sends both a percentage and an amount is ambiguous about which
 * one the operator meant to give away, and guessing wrong overcharges or
 * undercharges a real customer.
 */
export function resolveMembershipDiscount(
  input: MembershipDiscountInput
): MembershipDiscountResult<MembershipDiscount> {
  const percentOff = input.percentOff ?? null;
  const amountOffCents =
    input.amountOffUsd == null ? null : Math.round(input.amountOffUsd * 100);

  if (percentOff === null && amountOffCents === null) {
    return { ok: false, message: "Set a percentage off or an amount off" };
  }
  if (percentOff !== null && amountOffCents !== null) {
    return { ok: false, message: "Set only one of a percentage off or an amount off" };
  }
  if (
    percentOff !== null &&
    (!Number.isFinite(percentOff) ||
      percentOff < DISCOUNT_PERCENT_MIN ||
      percentOff > DISCOUNT_PERCENT_MAX)
  ) {
    return {
      ok: false,
      message: `A percentage off must be between ${DISCOUNT_PERCENT_MIN} and ${DISCOUNT_PERCENT_MAX}`
    };
  }
  if (
    amountOffCents !== null &&
    (!Number.isFinite(amountOffCents) ||
      amountOffCents < DISCOUNT_AMOUNT_MIN_CENTS ||
      amountOffCents > DISCOUNT_AMOUNT_MAX_CENTS)
  ) {
    return {
      ok: false,
      message: `An amount off must be between ${formatPriceCents(DISCOUNT_AMOUNT_MIN_CENTS)} and ${formatPriceCents(DISCOUNT_AMOUNT_MAX_CENTS)}`
    };
  }

  const durationInMonths = input.durationInMonths ?? null;
  if (input.duration === "repeating") {
    if (
      durationInMonths === null ||
      !Number.isInteger(durationInMonths) ||
      durationInMonths < 1 ||
      durationInMonths > DISCOUNT_MAX_MONTHS
    ) {
      return {
        ok: false,
        message: `A repeating discount needs a whole number of months between 1 and ${DISCOUNT_MAX_MONTHS}`
      };
    }
  } else if (durationInMonths !== null) {
    return { ok: false, message: "Only a repeating discount takes a number of months" };
  }

  return {
    ok: true,
    value: {
      percentOff,
      amountOffCents,
      duration: input.duration,
      durationInMonths: input.duration === "repeating" ? durationInMonths : null
    }
  };
}

/** The operator's label, which Stripe shows the customer on the invoice. */
export function resolveMembershipDiscountLabel(
  label: string
): MembershipDiscountResult<string> {
  const trimmed = label.trim();
  if (
    trimmed.length < DISCOUNT_LABEL_MIN_LENGTH ||
    trimmed.length > DISCOUNT_LABEL_MAX_LENGTH
  ) {
    return {
      ok: false,
      message: `A reason must be between ${DISCOUNT_LABEL_MIN_LENGTH} and ${DISCOUNT_LABEL_MAX_LENGTH} characters`
    };
  }
  return { ok: true, value: trimmed };
}

/** Stripe `coupons.create` params for one membership discount. */
export type DiscountCouponParams = {
  name: string;
  duration: MembershipDiscountDuration;
  duration_in_months?: number;
  percent_off?: number;
  amount_off?: number;
  currency?: string;
  applies_to: { products: string[] };
  metadata: Record<string, string>;
};

/**
 * Shape the coupon.
 *
 * `applies_to.products` is the load-bearing field, for the same reason it is
 * in the promo-code path: a subscription here can carry more than the plan.
 * The Canadian and Mexican messaging surcharges ride it as recurring line
 * items, and usage packs ride it as recurring add-ons. An unscoped coupon
 * would take the operator's 30% off those pass-throughs too, which is real
 * money the platform pays out and does not get back. Callers pass the product
 * behind the tenant's OWN plan item, read off the live subscription rather
 * than inferred from the tier, so a grandfathered price is scoped correctly.
 */
export function buildDiscountCouponParams(params: {
  label: string;
  discount: MembershipDiscount;
  productIds: string[];
  metadata: Record<string, string>;
}): DiscountCouponParams {
  const { discount } = params;
  return {
    name: params.label,
    duration: discount.duration,
    ...(discount.durationInMonths === null
      ? {}
      : { duration_in_months: discount.durationInMonths }),
    ...(discount.percentOff === null
      ? { amount_off: discount.amountOffCents ?? 0, currency: "usd" }
      : { percent_off: discount.percentOff }),
    applies_to: { products: params.productIds },
    metadata: params.metadata
  };
}

/**
 * Attach one coupon, replacing whatever discounts the subscription carried.
 *
 * A POPULATED array is Stripe's "overwrite" form, which is what an apply/remove
 * lever wants: applying a second discount replaces the first rather than
 * stacking two comps nobody is tracking.
 *
 * No `proration_behavior`: nothing about the priced items changes, so there is
 * no proration to suppress. The discount simply lands on the next invoice.
 *
 * The expands are what let the caller mirror from Stripe's own answer instead
 * of from what it asked for. Without `discounts.source.coupon` the response
 * carries only discount ids, and the mirror would have nothing to write.
 */
export type ApplyDiscountParams = {
  discounts: Array<{ coupon: string }>;
  expand: string[];
};

export function buildApplyDiscountParams(couponId: string): ApplyDiscountParams {
  return { discounts: [{ coupon: couponId }], expand: ["discounts.source.coupon"] };
}

/**
 * Clear every discount.
 *
 * The empty STRING is not a typo and not interchangeable with `[]`. Stripe
 * documents the array form as "if not specified or empty array, it leaves the
 * subscription's discounts unchanged. If empty string, it clears the
 * subscription's discounts." So the intuitive `discounts: []` is a silent
 * no-op: the route would report success, the audit line would record a
 * removal, and the customer would keep getting the discount forever.
 */
export type RemoveDiscountParams = {
  discounts: "";
  expand: string[];
};

export function buildRemoveDiscountParams(): RemoveDiscountParams {
  return { discounts: "", expand: ["discounts.source.coupon"] };
}

/** The `subscriptions` columns this feature mirrors. */
export type MembershipDiscountState = {
  discount_coupon_id: string | null;
  discount_name: string | null;
  discount_percent_off: number | null;
  discount_amount_off_cents: number | null;
  discount_duration: MembershipDiscountDuration | null;
  discount_duration_in_months: number | null;
  discount_started_at: string | null;
  discount_ends_at: string | null;
};

/** Every column null: what "this tenant has no discount" looks like. */
export const NO_MEMBERSHIP_DISCOUNT: MembershipDiscountState = {
  discount_coupon_id: null,
  discount_name: null,
  discount_percent_off: null,
  discount_amount_off_cents: null,
  discount_duration: null,
  discount_duration_in_months: null,
  discount_started_at: null,
  discount_ends_at: null
};

function unixToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Read the live discount off a Stripe subscription, for the DB mirror.
 *
 * Three-way on purpose, and the third case is the one that matters:
 *
 *   - `[]`                      → the state with every column null. Stripe is
 *                                 telling us there is definitely no discount,
 *                                 so the mirror is cleared. This is how a
 *                                 discount removed in the Stripe dashboard, or
 *                                 expired on its own, stops being claimed on
 *                                 the admin page.
 *   - a fully expanded discount → that discount's state.
 *   - anything else             → NULL, meaning "cannot tell, leave the mirror
 *                                 alone".
 *
 * That last case is not hypothetical: `discounts` comes back as bare id
 * strings unless the caller expanded it, and WEBHOOK PAYLOADS CANNOT EXPAND.
 * A reader that folded "unreadable" into "no discount" would have every
 * `customer.subscription.updated` event wipe the mirror of a discounted
 * tenant, and the admin page would then offer to apply a discount that is
 * already live. Returning null costs us only the ability to ADOPT a discount
 * someone attached outside this lever, which stays invisible to the mirror;
 * the admin panel's copy says so instead of implying otherwise.
 */
export function discountStateFromStripeSubscription(
  sub: unknown
): MembershipDiscountState | null {
  const record = asRecord(sub);
  const discounts = record?.discounts;
  if (!Array.isArray(discounts)) return null;
  if (discounts.length === 0) return NO_MEMBERSHIP_DISCOUNT;

  const discount = asRecord(discounts[0]);
  const coupon = asRecord(asRecord(discount?.source)?.coupon);
  if (!discount || !coupon) return null;

  const couponId = coupon.id;
  const duration = coupon.duration;
  if (typeof couponId !== "string") return null;
  if (duration !== "once" && duration !== "repeating" && duration !== "forever") return null;

  const percentOff = coupon.percent_off;
  const amountOff = coupon.amount_off;
  const durationInMonths = coupon.duration_in_months;
  const name = coupon.name;

  return {
    discount_coupon_id: couponId,
    discount_name: typeof name === "string" ? name : null,
    discount_percent_off: typeof percentOff === "number" ? percentOff : null,
    discount_amount_off_cents: typeof amountOff === "number" ? amountOff : null,
    discount_duration: duration,
    discount_duration_in_months:
      duration === "repeating" && typeof durationInMonths === "number" ? durationInMonths : null,
    discount_started_at: unixToIso(discount.start),
    discount_ends_at: unixToIso(discount.end)
  };
}

/**
 * Coalesce a partial/loose row into the full state.
 *
 * Callers hand this rows from anywhere: a Supabase select that predates the
 * columns, a test fixture built before the feature, a spread that leaves keys
 * `undefined` rather than absent. `undefined` is the dangerous one, because it
 * is NOT null and would sail past a `!== null` check into arithmetic, turning
 * a revenue number into NaN. Everything unrecognized lands as null here so the
 * readers below only ever see the two states they are written for.
 */
export function toMembershipDiscountState(
  partial: Partial<MembershipDiscountState> | null | undefined
): MembershipDiscountState {
  const source = partial ?? {};
  const pick = <K extends keyof MembershipDiscountState>(
    key: K
  ): MembershipDiscountState[K] => (source[key] ?? null) as MembershipDiscountState[K];
  return {
    discount_coupon_id: pick("discount_coupon_id"),
    discount_name: pick("discount_name"),
    discount_percent_off: pick("discount_percent_off"),
    discount_amount_off_cents: pick("discount_amount_off_cents"),
    discount_duration: pick("discount_duration"),
    discount_duration_in_months: pick("discount_duration_in_months"),
    discount_started_at: pick("discount_started_at"),
    discount_ends_at: pick("discount_ends_at")
  };
}

/**
 * True when the mirror describes a discount that is actually live.
 *
 * Tests the coupon id for a non-empty STRING rather than for `!== null`: this
 * predicate gates the money math below, and a row that arrived with the field
 * `undefined` (or blank) knows of no discount, whatever a null check would
 * say about it.
 */
export function hasMembershipDiscount(
  state: Pick<MembershipDiscountState, "discount_coupon_id">
): boolean {
  return typeof state.discount_coupon_id === "string" && state.discount_coupon_id !== "";
}

/**
 * Plain-language summary for the admin page and the tenant's billing page,
 * e.g. "30% off for 6 months" or "$40 off the next invoice".
 *
 * Returns null when nothing is live, so a caller can render the whole row
 * conditionally on one value.
 */
export function describeMembershipDiscount(
  state: MembershipDiscountState
): string | null {
  if (!hasMembershipDiscount(state)) return null;

  const amount =
    state.discount_percent_off !== null
      ? `${state.discount_percent_off}% off`
      : state.discount_amount_off_cents !== null
        ? `${formatPriceCents(state.discount_amount_off_cents)} off`
        : "Discount";

  if (state.discount_duration === "forever") return `${amount}, every invoice`;
  if (state.discount_duration === "repeating") {
    const months = state.discount_duration_in_months ?? 0;
    return `${amount} for ${months} ${months === 1 ? "month" : "months"}`;
  }
  return `${amount} on the next invoice`;
}

/**
 * Whether a mirrored discount reduces RECURRING revenue as of `now`.
 *
 * A `once` discount does not: it takes one invoice down and the subscription
 * returns to list price, which is exactly the treatment mrr.ts already
 * documents for the monthly intro coupon. A `repeating` one counts only while
 * it is still running, so an expired comp stops depressing the tile even if
 * the mirror has not been re-read yet.
 */
export function membershipDiscountReducesMrr(
  state: MembershipDiscountState,
  now: Date
): boolean {
  if (!hasMembershipDiscount(state)) return false;
  if (state.discount_duration === "once") return false;
  if (state.discount_ends_at === null) return true;
  const endsAt = Date.parse(state.discount_ends_at);
  return !Number.isFinite(endsAt) || endsAt > now.getTime();
}

/**
 * Apply a mirrored discount to a monthly rate in cents, for the MRR tile.
 *
 * Clamped at zero: a fixed-amount comp larger than the plan zeroes the line
 * rather than going negative, which is what Stripe does to the invoice.
 */
export function applyMembershipDiscountToCents(
  cents: number,
  state: Partial<MembershipDiscountState> | null | undefined,
  now: Date
): number {
  const resolved = toMembershipDiscountState(state);
  if (!membershipDiscountReducesMrr(resolved, now)) return cents;
  const percentOff = resolved.discount_percent_off;
  if (typeof percentOff === "number" && Number.isFinite(percentOff)) {
    return Math.max(0, Math.round(cents * (1 - percentOff / 100)));
  }
  const amountOff = resolved.discount_amount_off_cents;
  if (typeof amountOff === "number" && Number.isFinite(amountOff)) {
    return Math.max(0, cents - amountOff);
  }
  // A live coupon whose value we cannot read is left at full price rather than
  // guessed at: overstating revenue is recoverable, inventing a number is not.
  return cents;
}

/**
 * Turn a Stripe rejection into something an operator can act on.
 *
 * The one worth translating in this fleet is the same one billing-date hits:
 * term (annual/biennial) subscriptions are driven by a subscription schedule,
 * and Stripe governs a scheduled subscription's discounts through its phases.
 */
export function describeMembershipDiscountStripeError(message: string): string {
  if (/schedule/i.test(message)) {
    return "Stripe manages this subscription with a commitment schedule, so its discounts are controlled by the schedule phases. Apply the discount to the schedule in the Stripe dashboard instead.";
  }
  return message;
}
