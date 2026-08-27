/**
 * POST /api/admin/billing-date
 *
 * Operator lever: move a tenant's next billing date. Implemented with Stripe's
 * `trial_end`, which is the supported way to push the next charge out and
 * re-anchor the billing cycle to the new date. Stripe only accepts future
 * dates, so this can extend a cycle (comp the gap) but never bill earlier.
 *
 * `proration_behavior: "none"` keeps it a pure comp: no credit, no catch-up
 * charge. The subscription reports `trialing` until the date arrives, which
 * the Stripe webhook already maps to our local `active` status.
 *
 * Side effect worth knowing: the billing period restarts at the change, so
 * the tenant's monthly usage windows (voice minutes, AI budget) re-anchor and
 * they get a fresh usage month.
 *
 * Term (annual/biennial) subscriptions are driven by a Stripe subscription
 * schedule, and Stripe refuses anchor edits on a scheduled subscription. That
 * rejection is translated into plain language rather than echoed raw.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import {
  getSubscription,
  updateSubscription,
  stripeSubscriptionPeriodCache
} from "@/lib/db/subscriptions";
import { getStripe } from "@/lib/stripe/client";
import {
  buildNextBillingDateParams,
  describeBillingDateStripeError
} from "@/lib/billing/admin-billing-controls";
import {
  introEndsAtMatchesPeriodEnd,
  isFirstBillingCycle
} from "@/lib/billing/monthly-intro-nudge";
import { logAdminAction } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

const schema = z.object({
  businessId: z.string().uuid(),
  /** ISO timestamp of the next charge. Must be in the future. */
  nextBillingAt: z.string().min(1)
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const subscription = await getSubscription(body.businessId);
    if (!subscription) {
      return errorResponse("NOT_FOUND", "No subscription record for this business", 404);
    }
    if (subscription.status !== "active") {
      return errorResponse("CONFLICT", "subscription_not_active", 409);
    }
    if (!subscription.stripe_subscription_id) {
      return errorResponse(
        "CONFLICT",
        "This subscription is not billed through Stripe, so it has no billing date to move.",
        409
      );
    }

    // Pass the paid-through date so the move can only ever push the charge
    // out (comp), never pull it in. Pulling it in collapses paid time with no
    // proration credit.
    const params = buildNextBillingDateParams(
      body.nextBillingAt,
      new Date(),
      subscription.stripe_current_period_end
    );
    if (!params.ok) return errorResponse("VALIDATION_ERROR", params.reason);

    let updated;
    try {
      updated = await getStripe().subscriptions.update(
        subscription.stripe_subscription_id,
        params.value
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("admin.billing-date: Stripe update failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        nextBillingAt: body.nextBillingAt,
        error: message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        describeBillingDateStripeError(message),
        500
      );
    }

    // Refresh the cached period bounds from Stripe's response so the owner's
    // billing page shows the new date without waiting on the webhook (and
    // without a live Stripe lookup, per src/lib/billing/renewal.ts).
    //
    // This comp EXTENDS the current cycle, and re-anchoring period_start is
    // exactly what breaks the intro nudge's derived first-cycle signal
    // (isFirstBillingCycle reads a comped first-cycle tenant as renewed, and
    // the "your intro price is ending" email silently never sends, audit
    // M3). So when the cycle being extended IS the intro cycle, by either
    // signal, stamp its new end; the nudge gate accepts the stamp.
    const wasIntroCycle =
      subscription.billing_period === "monthly" &&
      (isFirstBillingCycle(
        subscription.created_at,
        subscription.stripe_current_period_start
      ) ||
        introEndsAtMatchesPeriodEnd(subscription));
    const periodCache = stripeSubscriptionPeriodCache(updated);
    if ("stripe_current_period_end" in periodCache) {
      await updateSubscription(subscription.id, {
        ...periodCache,
        ...(wasIntroCycle
          ? { monthly_intro_ends_at: periodCache.stripe_current_period_end }
          : {})
      });
    } else {
      logger.warn("admin.billing-date: Stripe response carried no period bounds", {
        adminEmail: admin.email,
        businessId: body.businessId
      });
    }

    await logAdminAction({
      adminEmail: admin.email,
      action: "set_next_billing_date",
      businessId: body.businessId,
      detail: {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        nextBillingAt: body.nextBillingAt
      }
    });

    return successResponse({
      nextBillingAt:
        "stripe_current_period_end" in periodCache
          ? periodCache.stripe_current_period_end
          : null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
