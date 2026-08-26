/**
 * Stripe side of the admin membership discount: minting the coupon, attaching
 * it to a live subscription, and taking it back off.
 *
 * The pure rules (validation, payload shapes, reading Stripe's answer back for
 * the DB mirror) live in src/lib/billing/membership-discount.ts. This file is
 * only the calls, plus the two pieces of cleanup that keep a failed operation
 * from leaving debris behind.
 */

import type Stripe from "stripe";
import { getStripe } from "./client";
import {
  buildApplyDiscountParams,
  buildDiscountCouponParams,
  buildRemoveDiscountParams,
  type MembershipDiscount
} from "@/lib/billing/membership-discount";
import { logger } from "@/lib/logger";

/**
 * The Stripe product behind the tenant's OWN plan line.
 *
 * Read off the live subscription rather than resolved from the tier's
 * configured price ids, because those two can differ: a grandfathered tenant
 * sits on a price nobody is sold any more, and a coupon scoped to today's
 * product would simply never apply to them. Silently discounting nothing is
 * the worst outcome here, since the admin page would report the comp as live.
 *
 * `items.data[0]` is the plan item by this codebase's convention: every
 * add-on (the Canadian and Mexican messaging surcharges, the recurring usage
 * packs) is appended after it, and `ensureCommitmentSchedule` already relies
 * on the same ordering when it rebuilds schedule phases.
 */
export function planProductIdFromSubscription(subscription: Stripe.Subscription): string {
  const planItem = subscription.items.data[0];
  if (!planItem) {
    throw new Error(`Subscription ${subscription.id} has no items to discount`);
  }
  const product = planItem.price.product;
  return typeof product === "string" ? product : product.id;
}

export type ApplyMembershipDiscountResult = {
  couponId: string;
  subscription: Stripe.Subscription;
};

/**
 * Mint a coupon for this one tenant and attach it to their subscription.
 *
 * A fresh coupon every time, deliberately: Stripe coupons are immutable, so
 * there is nothing to reuse or edit, and a per-tenant coupon carries the
 * operator's reason and the businessId in its own metadata. That is what makes
 * a discount legible in the Stripe dashboard months later, when the only
 * question anyone asks is "why is this account paying less?".
 *
 * If the attach fails, the just-minted coupon is deleted before rethrowing, so
 * a rejected apply does not litter the account with orphaned coupons that were
 * never applied to anything. Modeled on `createPromotionCoupon`, which cleans
 * up the same way for the same reason.
 */
export async function applyMembershipDiscount(params: {
  subscriptionId: string;
  label: string;
  discount: MembershipDiscount;
  metadata: Record<string, string>;
  /**
   * The coupon this apply is REPLACING, if the tenant already carried one.
   * Attaching the new discount detaches the old one (a populated `discounts`
   * array overwrites), but detaching does not delete the coupon object, so
   * without this every re-comp would leave another orphan behind in the
   * Stripe account.
   */
  previousCouponId?: string | null;
}): Promise<ApplyMembershipDiscountResult> {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(params.subscriptionId);
  const productId = planProductIdFromSubscription(subscription);

  const coupon = await stripe.coupons.create(
    buildDiscountCouponParams({
      label: params.label,
      discount: params.discount,
      productIds: [productId],
      metadata: params.metadata
    }) as Stripe.CouponCreateParams
  );

  try {
    const updated = await stripe.subscriptions.update(
      params.subscriptionId,
      buildApplyDiscountParams(coupon.id) as Stripe.SubscriptionUpdateParams
    );
    // Only once the replacement is attached: deleting the old coupon first
    // would retire it while the customer still carried it, and a failed
    // attach would then leave them on a discount with no object behind it.
    if (params.previousCouponId && params.previousCouponId !== coupon.id) {
      await deleteCouponQuietly(params.previousCouponId, "replaced by a new discount");
    }
    return { couponId: coupon.id, subscription: updated };
  } catch (err) {
    await deleteCouponQuietly(coupon.id, "attach failed");
    throw err;
  }
}

/**
 * Detach every discount from the subscription, then retire the coupon.
 *
 * Order matters. Deleting a Stripe coupon does NOT revoke it from anyone who
 * already has it applied, so deleting first would retire the object while the
 * customer kept the discount, and the mirror would have no id left to clean up
 * with. Detaching first is the step that actually stops the money.
 *
 * The delete is therefore best-effort and never fails the removal: once the
 * subscription no longer carries it, a leftover coupon is inert.
 */
export async function removeMembershipDiscount(params: {
  subscriptionId: string;
  couponId: string | null;
}): Promise<Stripe.Subscription> {
  const stripe = getStripe();
  const updated = await stripe.subscriptions.update(
    params.subscriptionId,
    buildRemoveDiscountParams() as unknown as Stripe.SubscriptionUpdateParams
  );
  if (params.couponId) {
    await deleteCouponQuietly(params.couponId, "removed from subscription");
  }
  return updated;
}

async function deleteCouponQuietly(couponId: string, reason: string): Promise<void> {
  try {
    await getStripe().coupons.del(couponId);
  } catch (err) {
    logger.warn("membership-discount: coupon cleanup failed (non-fatal)", {
      couponId,
      reason,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
