/**
 * POST /api/billing/white-glove/checkout
 *
 * Authenticated tenant buys white-glove onboarding (Phase C5) — either a
 * fixed catalog package (`packId` from `src/lib/plans/white-glove.ts`) or a
 * CUSTOM admin-authored offer (`packId` = the offer's UUID; the stored
 * `white_glove_offers` row is the pricing source of truth). Both paths
 * confirm the caller's business has an active Stripe subscription, then
 * create a `mode=payment` Checkout Session with inline `price_data`. The
 * Stripe webhook records the purchase and opens the priority-support window
 * on success.
 *
 * Guards: a business that already owns the requested fixed package (or owns
 * `buildout`, which supersedes `setup`) gets a CONFLICT instead of a
 * double-charge (upgrading setup → buildout is allowed). A custom offer must
 * be OPEN and must belong to the caller's business.
 *
 * Returns `{ checkoutUrl }` so the client can `window.location = checkoutUrl`.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { getSubscription } from "@/lib/db/subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createWhiteGloveCheckoutSession } from "@/lib/stripe/client";
import { WHITE_GLOVE_PACKAGE_IDS, getWhiteGlovePackage } from "@/lib/plans/white-glove";
import { getWhiteGloveOffer } from "@/lib/db/white-glove-offers";
import {
  successResponse,
  errorResponse,
  handleRouteError
} from "@/lib/api-response";

const schema = z.object({
  // A fixed catalog id ("setup"/"buildout") or a custom offer UUID.
  packId: z.string().trim().min(1).max(64)
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
    const pkg = getWhiteGlovePackage(body.packId);
    const isCustomOffer = !pkg;
    if (isCustomOffer && !z.string().uuid().safeParse(body.packId).success) {
      return errorResponse("NOT_FOUND", "White-glove package is not available");
    }

    const db = await createSupabaseServiceClient();
    // Mirror the ordering the dashboard uses (created_at DESC) so an owner
    // with multiple businesses always checks out for the row the billing
    // page displays.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: businesses } = await db
      .from("businesses")
      .select("id, white_glove_package")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0] ?? null;
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found");
    }

    // Fixed packages only: never re-sell an owned package. Custom offers are
    // independent of package ownership (a bespoke deal can always be sold).
    if (pkg) {
      const owned = business.white_glove_package as "setup" | "buildout" | null;
      if (owned === pkg.id || owned === "buildout") {
        return errorResponse(
          "CONFLICT",
          "Your business already has this white-glove package (or a larger one)"
        );
      }
    }

    // Custom offer: the stored row is the pricing source of truth, and it
    // must be OPEN and belong to the CALLER'S business (an offer id leaked
    // across tenants must never be payable).
    let offer = null;
    if (isCustomOffer) {
      offer = await getWhiteGloveOffer(body.packId, db);
      if (!offer || offer.business_id !== business.id) {
        return errorResponse("NOT_FOUND", "White-glove package is not available");
      }
      if (offer.status !== "open") {
        return errorResponse("CONFLICT", "This offer is no longer available");
      }
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
      packageId: pkg ? pkg.id : "custom",
      packageName: pkg ? pkg.name : offer!.name,
      amountCents: pkg ? pkg.priceCents : offer!.amount_cents,
      businessId: business.id,
      offerId: offer?.id,
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
