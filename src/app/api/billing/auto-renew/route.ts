/**
 * POST /api/billing/auto-renew
 *
 * Body: `{ "autoRenew": boolean }`
 *
 * Toggles term-contract auto-renew (Hostinger-consistent model):
 * - ON: release the commitment schedule so the Stripe subscription renews
 *   for another FULL term at the contract price, charged upfront.
 * - OFF (default): re-create the schedule via `ensureCommitmentSchedule` so
 *   the plan rolls to month-to-month at the higher renewal price at term end.
 *
 * The Stripe change runs first; the `subscriptions.contract_auto_renew` flag
 * is only flipped after it succeeds, so the DB never claims a renewal
 * behavior Stripe isn't actually configured for.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getSubscription, isCommitmentElapsed, updateSubscription } from "@/lib/db/subscriptions";
import { ensureCommitmentSchedule, releaseCommitmentSchedule } from "@/lib/stripe/client";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  autoRenew: z.boolean()
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }

    const payload = bodySchema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    // Latest owned business — same ordering as /dashboard/billing and
    // /api/billing/cancel so the toggle acts on the row the page renders.
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0];
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const sub = await getSubscription(business.id, db);
    if (!sub || sub.status !== "active" || !sub.stripe_subscription_id) {
      return errorResponse("CONFLICT", "No active subscription to configure", 409);
    }
    if (sub.billing_period === "monthly" || !sub.billing_period || sub.tier === "enterprise") {
      return errorResponse(
        "CONFLICT",
        "Auto-renew only applies to 12/24-month contracts",
        409
      );
    }
    // Once the commitment has elapsed the plan is already rolling
    // month-to-month; there is no term left to auto-renew. Mirrors the UI
    // (toggle hidden, "Start a new contract" CTA shown) so a direct POST
    // can't release/recreate schedules on a rollover-phase subscription.
    if (isCommitmentElapsed(sub)) {
      return errorResponse(
        "CONFLICT",
        "The contract term has ended; start a new contract instead",
        409
      );
    }

    if (payload.autoRenew) {
      await releaseCommitmentSchedule(sub.stripe_subscription_id);
    } else {
      await ensureCommitmentSchedule({
        subscriptionId: sub.stripe_subscription_id,
        tier: sub.tier,
        billingPeriod: sub.billing_period
      });
    }

    await updateSubscription(sub.id, { contract_auto_renew: payload.autoRenew }, db);

    logger.info("billing auto-renew toggled", {
      businessId: business.id,
      subscriptionId: sub.id,
      autoRenew: payload.autoRenew
    });

    return successResponse({ autoRenew: payload.autoRenew });
  } catch (err) {
    return handleRouteError(err);
  }
}
