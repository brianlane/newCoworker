/**
 * Stripe side of admin promotions: minting, retiring, and replacing the
 * Coupon + Promotion Code pair that prices a promo code.
 *
 * Division of responsibility (see the promotions migration for the long
 * version): the `promotions` ROW owns lifecycle (the active toggle, the
 * starts_at/ends_at window, the redemption cap, the tier/period scope) and
 * Stripe owns only the money. That split exists because Stripe coupons are
 * immutable and a promotion code's `redeem_by` / `max_redemptions` are fixed
 * at creation, none of which survives an admin surface with real CRUD. So we
 * deliberately do NOT pass those fields to Stripe; validatePromoCode is the
 * gate, and the Stripe code's own `active` flag is kept in step as a backstop.
 */
import type Stripe from "stripe";
import { getStripe, resolvePriceId } from "./client";
import type { BillingPeriod } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

export type PromotionTier = "starter" | "standard";

export type PromotionDuration = "once" | "repeating" | "forever";

/**
 * The discount itself. Exactly one of `percentOff` / `amountOffCents` is set,
 * mirroring the promotions_one_discount_shape table CHECK.
 */
export type PromotionDiscount = {
  percentOff: number | null;
  amountOffCents: number | null;
  duration: PromotionDuration;
  durationInMonths: number | null;
};

export type PromotionStripeIds = {
  couponId: string;
  promotionCodeId: string;
};

const PLAN_PERIODS: BillingPeriod[] = ["monthly", "annual", "biennial"];

/**
 * The Stripe products behind the membership plans a promotion may be redeemed
 * against, resolved from the configured signup price ids.
 *
 * This is what keeps a promo code off everything that is NOT the membership:
 * the one-time 10DLC carrier-registration pass-through and the Canadian
 * messaging surcharge ride the same Checkout Session as inline `price_data`
 * lines, and an unrestricted coupon would discount those pass-throughs too.
 * Scoping to the ALLOWED tiers additionally means a starter-only code cannot
 * price a standard plan even if our own validation were bypassed.
 */
export async function resolveMembershipProductIds(tiers: PromotionTier[]): Promise<string[]> {
  const stripe = getStripe();
  const productIds = new Set<string>();
  for (const tier of tiers) {
    for (const period of PLAN_PERIODS) {
      const price = await stripe.prices.retrieve(resolvePriceId(tier, period));
      productIds.add(typeof price.product === "string" ? price.product : price.product.id);
    }
  }
  return [...productIds];
}

function couponCreateParams(
  name: string,
  discount: PromotionDiscount,
  productIds: string[]
): Stripe.CouponCreateParams {
  return {
    name,
    duration: discount.duration,
    ...(discount.durationInMonths === null
      ? {}
      : { duration_in_months: discount.durationInMonths }),
    ...(discount.percentOff === null
      ? { amount_off: discount.amountOffCents ?? 0, currency: "usd" }
      : { percent_off: discount.percentOff }),
    applies_to: { products: productIds }
  };
}

/**
 * Mint the Coupon + Promotion Code pair for a new promotion.
 *
 * If the promotion-code create fails (most likely cause: the customer-facing
 * code collides with another ACTIVE code) the just-created coupon is deleted
 * before rethrowing, so a failed admin submit does not litter the Stripe
 * account with orphaned coupons.
 */
export async function createPromotionCoupon(params: {
  code: string;
  name: string;
  tiers: PromotionTier[];
  discount: PromotionDiscount;
}): Promise<PromotionStripeIds> {
  const stripe = getStripe();
  const productIds = await resolveMembershipProductIds(params.tiers);
  const coupon = await stripe.coupons.create(
    couponCreateParams(params.name, params.discount, productIds)
  );
  try {
    const promotionCode = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code: params.code
    });
    return { couponId: coupon.id, promotionCodeId: promotionCode.id };
  } catch (err) {
    try {
      await stripe.coupons.del(coupon.id);
    } catch (cleanupErr) {
      logger.warn("promotions: orphaned Stripe coupon left behind after a failed code mint", {
        couponId: coupon.id,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      });
    }
    throw err;
  }
}

/** Back the per-promotion admin toggle on the Stripe side. */
export async function setPromotionCodeActive(
  promotionCodeId: string,
  active: boolean
): Promise<void> {
  await getStripe().promotionCodes.update(promotionCodeId, { active });
}

/**
 * Swap in a new discount VALUE under the same customer-facing code, for an
 * admin edit that changes percent/amount (or duration, or the tier scope the
 * coupon is restricted to). Stripe coupons are immutable, so "editing" is
 * really: retire the old code, mint a replacement pair with the same string.
 *
 * The old COUPON is deliberately left in place rather than deleted. A Checkout
 * Session minted moments before the edit still references it, and deleting a
 * coupon out from under a session in flight would fail the customer's payment;
 * a retired coupon with no active code attached is unreachable and harmless.
 *
 * On failure the old code is re-activated so an edit that could not complete
 * leaves the promotion exactly as it was rather than silently dead.
 */
export async function replacePromotionCoupon(params: {
  previous: PromotionStripeIds;
  code: string;
  name: string;
  tiers: PromotionTier[];
  discount: PromotionDiscount;
}): Promise<PromotionStripeIds> {
  await setPromotionCodeActive(params.previous.promotionCodeId, false);
  try {
    return await createPromotionCoupon({
      code: params.code,
      name: params.name,
      tiers: params.tiers,
      discount: params.discount
    });
  } catch (err) {
    try {
      await setPromotionCodeActive(params.previous.promotionCodeId, true);
    } catch (restoreErr) {
      logger.warn("promotions: could not re-activate the previous Stripe code after a failed edit", {
        promotionCodeId: params.previous.promotionCodeId,
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
      });
    }
    throw err;
  }
}

/**
 * Retire a promotion's Stripe objects for good (admin delete, which the API
 * allows only on a promotion nobody has redeemed). Deleting the coupon is what
 * makes the code permanently unusable, because Stripe marks every promotion
 * code on an invalid coupon permanently inactive, so the deactivate is belt and
 * braces for the window between the two calls.
 */
export async function deletePromotionCoupon(ids: PromotionStripeIds): Promise<void> {
  const stripe = getStripe();
  await setPromotionCodeActive(ids.promotionCodeId, false);
  await stripe.coupons.del(ids.couponId);
}
