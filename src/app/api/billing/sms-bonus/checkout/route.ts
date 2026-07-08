/**
 * POST /api/billing/sms-bonus/checkout
 *
 * Self-serve top-up: authenticated tenant buys an SMS bonus pack. Mirrors
 * /api/billing/voice-bonus/checkout: pick a `packId` from
 * `src/lib/billing/sms-bonus-packs.ts`, confirm the caller's business has an
 * active Stripe subscription, then create a `mode=payment` Checkout Session.
 * The Stripe webhook records the grant on success; refund / dispute-lost
 * clawback is wired in the webhook handler.
 *
 * Returns `{ checkoutUrl }` so the client can `window.location = checkoutUrl`.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { getSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createSmsBonusCheckoutSession } from "@/lib/stripe/client";
import { SMS_BONUS_PACK_IDS, getSmsBonusPack } from "@/lib/billing/sms-bonus-packs";
import {
  successResponse,
  errorResponse,
  handleRouteError
} from "@/lib/api-response";

const schema = z.object({
  packId: z.enum(SMS_BONUS_PACK_IDS)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = schema.parse(await request.json());
    const pack = getSmsBonusPack(body.packId);
    if (!pack) {
      return errorResponse("NOT_FOUND", "SMS bonus pack is not available");
    }

    const db = await createSupabaseServiceClient();
    // Mirror the ordering the dashboard uses (created_at DESC) so an owner
    // with multiple businesses always checks out for the row the billing
    // page displays.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0] ?? null;
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found");
    }

    const subscription = await getSubscription(business.id);
    if (!subscription?.stripe_subscription_id || subscription.status !== "active") {
      return errorResponse(
        "CONFLICT",
        "An active subscription is required before buying bonus texts"
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const session = await createSmsBonusCheckoutSession({
      priceId: pack.priceId,
      businessId: business.id,
      smsTexts: pack.texts,
      successUrl: `${appUrl}/dashboard/billing?bonus=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/dashboard/billing?bonus=cancelled`,
      customerEmail: user.email,
      customerId: subscription.stripe_customer_id ?? undefined,
      userId: user.userId
    });

    return successResponse({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    return handleRouteError(err);
  }
}
