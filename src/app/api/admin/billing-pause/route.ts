/**
 * POST /api/admin/billing-pause
 *
 * Operator lever: pause or resume Stripe collection for a tenant while the
 * service keeps running. Paused means Stripe voids the invoices it generates
 * (behavior "void"), so the tenant is comped and never enters dunning.
 *
 * Deliberately NOT a cancel: `pause_collection` leaves the subscription
 * `active` at Stripe and in our row, so the box, the DID, and the AiFlows all
 * keep running. The tenant sees no cancellation email and nothing enters the
 * grace window.
 *
 * Guards: the subscription must exist, be `active`, and be Stripe-linked. A
 * Stripe-less row (admin-created enterprise, skip-payment, internal pilot) has
 * no collection to pause, and pretending otherwise would leave the mirror
 * columns claiming a pause Stripe never knew about.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription, updateSubscription } from "@/lib/db/subscriptions";
import { getStripe } from "@/lib/stripe/client";
import {
  buildPauseCollectionParams,
  buildResumeCollectionParams,
  pauseStateFromStripeSubscription
} from "@/lib/billing/admin-billing-controls";
import { logAdminAction } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

const schema = z.object({
  businessId: z.string().uuid(),
  action: z.enum(["pause", "resume"]),
  /** Optional auto-resume date for a pause; ignored on resume. */
  resumesAt: z.string().min(1).nullish()
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
        "This subscription is not billed through Stripe, so there is nothing to pause.",
        409
      );
    }

    let params;
    if (body.action === "pause") {
      const built = buildPauseCollectionParams(body.resumesAt, new Date());
      if (!built.ok) return errorResponse("VALIDATION_ERROR", built.reason);
      params = built.value;
    } else {
      params = buildResumeCollectionParams();
    }

    let updated;
    try {
      updated = await getStripe().subscriptions.update(
        subscription.stripe_subscription_id,
        params
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("admin.billing-pause: Stripe update failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        action: body.action,
        error: message
      });
      return errorResponse("INTERNAL_SERVER_ERROR", message, 500);
    }

    // Mirror what Stripe actually returned rather than what we asked for, so
    // the row can never claim a pause Stripe declined to apply.
    const state = pauseStateFromStripeSubscription(updated);
    await updateSubscription(subscription.id, state);

    await logAdminAction({
      adminEmail: admin.email,
      action: body.action === "pause" ? "billing_pause" : "billing_resume",
      businessId: body.businessId,
      detail: {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        resumesAt: state.billing_pause_resumes_at
      }
    });

    return successResponse(state);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
