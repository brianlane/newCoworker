/**
 * POST / DELETE /api/admin/membership-discount
 *
 * Operator lever: take a percentage or a dollar amount off a membership that
 * is ALREADY being billed, and take it back off again.
 *
 * This is the gap between the levers that existed before it. `promotions`
 * prices a promo code at signup and is never consulted again; change-plan and
 * reactivate deliberately withhold discounts; pause-collection and
 * billing-date are all-or-nothing comps. Nothing could give a paying tenant
 * 30% off going forward.
 *
 * POST applies (and replaces any discount already attached, rather than
 * stacking a second one). DELETE removes.
 *
 * Guards mirror billing-pause: the subscription must exist, be `active`, and
 * be Stripe-linked. A Stripe-less row (admin-created enterprise, skip-payment,
 * internal pilot) has no invoice to discount, and pretending otherwise would
 * leave the mirror columns claiming a discount Stripe never knew about.
 *
 * What the operator is promised, and what actually happens: the discount lands
 * on the NEXT invoice. Stripe never credits the cycle already paid, so a
 * mid-cycle apply changes nothing until the renewal. Refunding the current
 * cycle is a different lever (force-refund), and conflating the two would have
 * an operator believe they had issued a credit they had not.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import {
  applyMembershipDiscount,
  removeMembershipDiscount
} from "@/lib/stripe/subscription-discount";
import {
  DISCOUNT_MAX_MONTHS,
  describeMembershipDiscount,
  describeMembershipDiscountStripeError,
  discountStateFromStripeSubscription,
  NO_MEMBERSHIP_DISCOUNT,
  resolveMembershipDiscount,
  resolveMembershipDiscountLabel
} from "@/lib/billing/membership-discount";
import { logAdminAction } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

const applySchema = z.object({
  businessId: z.string().uuid(),
  /** Why the discount was granted. Stripe shows it on the invoice. */
  label: z.string(),
  percentOff: z.number().nullish(),
  /** Whole dollars from the admin form; converted to cents in the resolver. */
  amountOffUsd: z.number().nullish(),
  duration: z.enum(["once", "repeating", "forever"]),
  durationInMonths: z.number().int().min(1).max(DISCOUNT_MAX_MONTHS).nullish()
});

const removeSchema = z.object({ businessId: z.string().uuid() });

/**
 * The shared preconditions. Returns the subscription row, or the response to
 * send instead, so apply and remove cannot drift on which tenants they accept.
 */
async function loadDiscountableSubscription(businessId: string) {
  const business = await getBusiness(businessId);
  if (!business) {
    return { ok: false as const, response: errorResponse("NOT_FOUND", "Business not found", 404) };
  }
  const subscription = await getSubscription(businessId);
  if (!subscription) {
    return {
      ok: false as const,
      response: errorResponse("NOT_FOUND", "No subscription record for this business", 404)
    };
  }
  if (subscription.status !== "active") {
    return { ok: false as const, response: errorResponse("CONFLICT", "subscription_not_active", 409) };
  }
  if (!subscription.stripe_subscription_id) {
    return {
      ok: false as const,
      response: errorResponse(
        "CONFLICT",
        "This subscription is not billed through Stripe, so there is nothing to discount.",
        409
      )
    };
  }
  return { ok: true as const, subscription };
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = applySchema.parse(await request.json());

    const loaded = await loadDiscountableSubscription(body.businessId);
    if (!loaded.ok) return loaded.response;
    const { subscription } = loaded;

    const label = resolveMembershipDiscountLabel(body.label);
    if (!label.ok) return errorResponse("VALIDATION_ERROR", label.message);

    const discount = resolveMembershipDiscount({
      percentOff: body.percentOff,
      amountOffUsd: body.amountOffUsd,
      duration: body.duration,
      durationInMonths: body.durationInMonths
    });
    if (!discount.ok) return errorResponse("VALIDATION_ERROR", discount.message);

    let result;
    try {
      result = await applyMembershipDiscount({
        // Non-null: `loadDiscountableSubscription` refuses a Stripe-less row.
        subscriptionId: subscription.stripe_subscription_id as string,
        label: label.value,
        discount: discount.value,
        // Retire whatever coupon this comp replaces, so re-comping a tenant
        // does not pile up orphaned coupons in the Stripe account.
        previousCouponId: subscription.discount_coupon_id,
        // Metadata is what makes the coupon legible in the Stripe dashboard
        // long after the fact, when the only question is why this account is
        // paying less than its plan.
        metadata: {
          businessId: body.businessId,
          appliedBy: admin.email ?? admin.userId,
          source: "admin_membership_discount"
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("admin.membership-discount: Stripe apply failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        error: message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        describeMembershipDiscountStripeError(message),
        500
      );
    }

    // Mirror what Stripe actually returned, never what we asked for, so the
    // row can never claim a discount Stripe declined to attach. A response we
    // cannot read (no expansion) leaves the mirror alone rather than writing a
    // half-true one; the coupon id is still recorded on the audit line.
    const state = discountStateFromStripeSubscription(result.subscription);
    if (state) await updateSubscription(subscription.id, state);

    await logAdminAction({
      adminEmail: admin.email,
      action: "membership_discount_apply",
      businessId: body.businessId,
      detail: {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        couponId: result.couponId,
        label: label.value,
        percentOff: discount.value.percentOff,
        amountOffCents: discount.value.amountOffCents,
        duration: discount.value.duration,
        durationInMonths: discount.value.durationInMonths,
        mirrored: state !== null
      }
    });

    return successResponse({
      couponId: result.couponId,
      discount: state,
      summary: state ? describeMembershipDiscount(state) : null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = removeSchema.parse(await request.json());

    const loaded = await loadDiscountableSubscription(body.businessId);
    if (!loaded.ok) return loaded.response;
    const { subscription } = loaded;

    let updated;
    try {
      updated = await removeMembershipDiscount({
        subscriptionId: subscription.stripe_subscription_id as string,
        couponId: subscription.discount_coupon_id
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("admin.membership-discount: Stripe remove failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        error: message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        describeMembershipDiscountStripeError(message),
        500
      );
    }

    // A removal that Stripe confirmed is the one case where clearing the
    // mirror outright is correct even if the response was not readable: we
    // asked for every discount to be cleared and Stripe did not object.
    const state = discountStateFromStripeSubscription(updated) ?? NO_MEMBERSHIP_DISCOUNT;
    await updateSubscription(subscription.id, state);

    await logAdminAction({
      adminEmail: admin.email,
      action: "membership_discount_remove",
      businessId: body.businessId,
      detail: {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        couponId: subscription.discount_coupon_id
      }
    });

    return successResponse({ discount: state });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
