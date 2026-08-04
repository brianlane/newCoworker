/**
 * POST /api/billing/auto-reload/card
 *
 * Mints a fresh `mode: "setup"` Checkout so the tenant can replace the card
 * auto-reload charges.
 *
 * This is NOT the Stripe billing portal. The portal updates the card on the
 * MEMBERSHIP subscription; auto-reload charges a separately authorized
 * payment method stored in `usage_pack_auto_reload_cards`, and nothing the
 * portal does touches that row. Sending tenants to the portal to "update
 * their auto-reload card" would leave the sweep charging the old method.
 */
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getSubscription } from "@/lib/db/subscriptions";
import { createAutoReloadSetupSession } from "@/lib/stripe/client";
import { logger } from "@/lib/logger";

export async function POST() {
  try {
    const user = await getAuthUser();
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) {
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }

    const businessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    if (!businessId) return errorResponse("NOT_FOUND", "Business not found", 404);

    const db = await createSupabaseServiceClient();
    const sub = await getSubscription(businessId, db);
    if (!sub?.stripe_customer_id) {
      return errorResponse("CONFLICT", "No billing account on file; contact support", 409);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const session = await createAutoReloadSetupSession({
      customerId: sub.stripe_customer_id,
      businessId,
      userId: user.userId,
      successUrl: `${appUrl}/dashboard/billing?autoReload=ready`,
      cancelUrl: `${appUrl}/dashboard/billing?autoReload=canceled`
    });

    logger.info("auto-reload card re-authorization started", { businessId });
    return successResponse({ setupUrl: session.url });
  } catch (err) {
    return handleRouteError(err);
  }
}
