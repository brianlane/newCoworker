/**
 * Promo-code validation and discount math.
 *
 * This module is the single gate every redemption passes through. The Step 3
 * order-summary preview and `/api/checkout` both call `validatePromotionCode`,
 * so what a customer is shown and what Stripe charges cannot diverge. And
 * because it is the only path, the `promotions` row (not the immutable Stripe
 * coupon) can own the active toggle, the date window, and the redemption cap.
 */
import {
  countPromotionRedemptions,
  getPromotionByCode,
  type PromotionRow
} from "@/lib/db/promotions";
import { getPlanDueTodayCents, getPlanListPriceCents } from "@/lib/pricing";
import type { BillingPeriod } from "@/lib/plans/tier";
import type { PromotionTier } from "@/lib/stripe/promotions";

export type PromotionRejection =
  | "not_found"
  | "inactive"
  | "scheduled"
  | "expired"
  | "exhausted"
  | "tier_not_allowed"
  | "period_not_allowed"
  | "not_better";

export type PromotionValidation =
  | {
      ok: true;
      promotion: PromotionRow;
      /** Cents this code takes off the plan line. */
      discountCents: number;
      /** Plan portion of "due today" once the code is applied. */
      planDueTodayCents: number;
    }
  | { ok: false; reason: PromotionRejection };

/** Codes are stored uppercase; customers type them however they like. */
export function normalizePromotionCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Cents a promotion takes off the plan line for one tier/period, never more
 * than the line itself (a $50 code against a $15.99 monthly plan zeroes the
 * plan rather than crediting the difference against the carrier fee).
 */
export function computePromotionDiscountCents(
  promotion: Pick<PromotionRow, "percent_off" | "amount_off_cents">,
  tier: PromotionTier,
  period: BillingPeriod
): number {
  const listCents = getPlanListPriceCents(tier, period);
  const raw =
    promotion.percent_off === null
      ? (promotion.amount_off_cents ?? 0)
      : Math.round((listCents * promotion.percent_off) / 100);
  return Math.min(raw, listCents);
}

/**
 * Lifecycle state for the admin table's status badge. `exhausted` and
 * `expired` outrank `off` because they describe why a code stopped working
 * even while its toggle is still on.
 */
export type PromotionLifecycle = "active" | "scheduled" | "expired" | "exhausted" | "off";

export function promotionLifecycle(
  promotion: Pick<PromotionRow, "active" | "starts_at" | "ends_at" | "max_redemptions">,
  redemptionCount: number,
  now: Date
): PromotionLifecycle {
  if (promotion.ends_at !== null && new Date(promotion.ends_at) <= now) return "expired";
  if (promotion.max_redemptions !== null && redemptionCount >= promotion.max_redemptions) {
    return "exhausted";
  }
  if (!promotion.active) return "off";
  if (new Date(promotion.starts_at) > now) return "scheduled";
  return "active";
}

/**
 * Check a resolved promotion against one checkout, given the redemption count
 * already on it. Split out from the DB lookup so the rules are directly
 * testable and so the admin surface can reuse the same reasoning.
 *
 * The last rule is the product one: a code is refused when it would leave the
 * customer paying MORE than they would without it. That is reachable on
 * monthly plans, where applying a promo replaces the standard intro coupon
 * (Stripe allows one discount per session): a small percentage off the full
 * rate can be worse than the intro price, and silently charging more for
 * entering a promo code would be indefensible.
 */
export function evaluatePromotion(
  promotion: PromotionRow,
  params: {
    tier: PromotionTier;
    period: BillingPeriod;
    redemptionCount: number;
    now: Date;
  }
): PromotionValidation {
  if (!promotion.active) return { ok: false, reason: "inactive" };
  if (new Date(promotion.starts_at) > params.now) return { ok: false, reason: "scheduled" };
  if (promotion.ends_at !== null && new Date(promotion.ends_at) <= params.now) {
    return { ok: false, reason: "expired" };
  }
  if (!promotion.allowed_tiers.includes(params.tier)) {
    return { ok: false, reason: "tier_not_allowed" };
  }
  if (!promotion.allowed_periods.includes(params.period)) {
    return { ok: false, reason: "period_not_allowed" };
  }
  if (
    promotion.max_redemptions !== null &&
    params.redemptionCount >= promotion.max_redemptions
  ) {
    return { ok: false, reason: "exhausted" };
  }

  const discountCents = computePromotionDiscountCents(promotion, params.tier, params.period);
  const planDueTodayCents = getPlanListPriceCents(params.tier, params.period) - discountCents;
  if (planDueTodayCents >= getPlanDueTodayCents(params.tier, params.period)) {
    return { ok: false, reason: "not_better" };
  }

  return { ok: true, promotion, discountCents, planDueTodayCents };
}

/**
 * Resolve and validate a customer-entered code. Used by the public preview
 * route and re-run server-side by `/api/checkout`, which fails closed on any
 * rejection rather than quietly charging full price.
 */
export async function validatePromotionCode(params: {
  code: string;
  tier: PromotionTier;
  period: BillingPeriod;
  now?: Date;
}): Promise<PromotionValidation> {
  const code = normalizePromotionCode(params.code);
  const promotion = await getPromotionByCode(code);
  if (!promotion) return { ok: false, reason: "not_found" };

  // Only pay for the count when a cap could actually bite.
  const redemptionCount =
    promotion.max_redemptions === null ? 0 : await countPromotionRedemptions(promotion.id);

  return evaluatePromotion(promotion, {
    tier: params.tier,
    period: params.period,
    redemptionCount,
    now: params.now ?? new Date()
  });
}
