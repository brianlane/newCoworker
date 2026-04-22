/**
 * POST /api/billing/voice-bonus/checkout
 *
 * Self-serve top-up: authenticated tenant buys a voice-bonus pack. The caller
 * picks a `packId` from the catalog in `src/lib/billing/voice-bonus-packs.ts`;
 * we look up the Stripe Price, confirm the caller owns exactly one business
 * with an active Stripe subscription, then create a Stripe Checkout Session in
 * `mode=payment`. The Stripe webhook records the grant on success. Refund /
 * dispute-lost clawback is already wired in the webhook handler.
 *
 * Returns `{ checkoutUrl }` so the client can `window.location = checkoutUrl`.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { getSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createVoiceBonusCheckoutSession } from "@/lib/stripe/client";
import {
  VOICE_BONUS_PACK_IDS,
  getVoiceBonusPack
} from "@/lib/billing/voice-bonus-packs";
import {
  successResponse,
  errorResponse,
  handleRouteError
} from "@/lib/api-response";

const schema = z.object({
  packId: z.enum(VOICE_BONUS_PACK_IDS)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = schema.parse(await request.json());
    const pack = getVoiceBonusPack(body.packId);
    if (!pack) {
      return errorResponse("NOT_FOUND", "Voice bonus pack is not available");
    }

    const db = await createSupabaseServiceClient();
    // Mirror the ordering the dashboard uses (created_at DESC) so an owner
    // with multiple businesses always sees and checks out for the same row
    // the billing page displays. Without this, Postgres is free to return
    // rows in an arbitrary order and the checkout session could target a
    // different business than the one shown to the user.
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
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
        "An active subscription is required before buying bonus minutes"
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const session = await createVoiceBonusCheckoutSession({
      priceId: pack.priceId,
      businessId: business.id,
      voiceSeconds: pack.seconds,
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
