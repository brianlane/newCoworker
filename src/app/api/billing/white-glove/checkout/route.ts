/**
 * POST /api/billing/white-glove/checkout
 *
 * Authenticated tenant buys a white-glove onboarding package (Phase C5).
 * Mirrors the usage-pack checkouts: pick a `packId` from
 * `src/lib/plans/white-glove.ts`, confirm the caller's business has an
 * active Stripe subscription, then create a `mode=payment` Checkout Session
 * with inline `price_data`. The Stripe webhook records the purchase and
 * opens the priority-support window on success.
 *
 * Guards: a business that already owns the requested package (or owns
 * `buildout`, which supersedes `setup`) gets a CONFLICT instead of a
 * double-charge. Upgrading setup → buildout is allowed.
 *
 * Returns `{ checkoutUrl }` so the client can `window.location = checkoutUrl`.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { getSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createWhiteGloveCheckoutSession } from "@/lib/stripe/client";
import { WHITE_GLOVE_PACKAGE_IDS, getWhiteGlovePackage } from "@/lib/plans/white-glove";
import {
  successResponse,
  errorResponse,
  handleRouteError
} from "@/lib/api-response";

const schema = z.object({
  packId: z.enum(WHITE_GLOVE_PACKAGE_IDS)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only: this route resolves the business from the
    // SIGNED-IN user's email, so an impersonating admin's write would land
    // on the wrong business. Refuse instead (see isViewAsActive).
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only — exit view-as to make changes", 403);
    }
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = schema.parse(await request.json());
    const pkg = getWhiteGlovePackage(body.packId);
    if (!pkg) {
      return errorResponse("NOT_FOUND", "White-glove package is not available");
    }

    const db = await createSupabaseServiceClient();
    // Mirror the ordering the dashboard uses (created_at DESC) so an owner
    // with multiple businesses always checks out for the row the billing
    // page displays.
    const { data: businesses } = await db
      .from("businesses")
      .select("id, white_glove_package")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0] ?? null;
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found");
    }

    const owned = business.white_glove_package as "setup" | "buildout" | null;
    if (owned === pkg.id || owned === "buildout") {
      return errorResponse(
        "CONFLICT",
        "Your business already has this white-glove package (or a larger one)"
      );
    }

    const subscription = await getSubscription(business.id);
    if (!subscription?.stripe_subscription_id || subscription.status !== "active") {
      return errorResponse(
        "CONFLICT",
        "An active subscription is required before buying white-glove onboarding"
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const session = await createWhiteGloveCheckoutSession({
      packageId: pkg.id,
      packageName: pkg.name,
      amountCents: pkg.priceCents,
      businessId: business.id,
      successUrl: `${appUrl}/dashboard/billing?whiteGlove=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/dashboard/billing?whiteGlove=cancelled`,
      customerEmail: user.email,
      customerId: subscription.stripe_customer_id ?? undefined,
      userId: user.userId
    });

    return successResponse({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    return handleRouteError(err);
  }
}
