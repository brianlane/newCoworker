/**
 * POST /api/billing/change-plan
 *
 * Body: `{ "tier": "starter"|"standard", "billingPeriod": "monthly"|"annual"|"biennial" }`
 *
 * Produces a Stripe Checkout URL for the NEW plan. Actual teardown of the
 * old sub + provisioning of the new VPS happens in the Stripe webhook
 * when `checkout.session.completed` fires with the `lifecycleAction=changePlan`
 * metadata we tag below.
 *
 * Policy (plan §Upgrade/downgrade): NO proration, NO credit. Caller is
 * warned by the UI that their existing plan ends without refund.
 */

import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { LIFETIME_SUBSCRIPTION_CAP } from "@/lib/db/customer-profiles";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  createCheckoutSession,
  resolvePriceId
} from "@/lib/stripe/client";

const bodySchema = z.object({
  tier: z.enum(["starter", "standard"]),
  billingPeriod: z.enum(["monthly", "annual", "biennial"])
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }
    const payload = bodySchema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    // Match the tenant-facing UI ordering (`/dashboard/billing`,
    // `/dashboard/layout.tsx`) so owners of multiple businesses act on the
    // same row the page renders.
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0];
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const ctxRes = await loadLifecycleContextForBusiness(business.id, {
      ownerAuthUserId: user.userId
    });
    if (!ctxRes.ok) {
      return errorResponse("NOT_FOUND", ctxRes.reason, 404);
    }
    const { subscription, profile } = ctxRes.context;

    // changePlan is meaningful only on an active sub (grace/wiped go through
    // /reactivate resubscribe instead). Mirrors the planner's precondition.
    if (subscription.status !== "active") {
      return errorResponse("CONFLICT", "subscription_not_active", 409);
    }
    // Abuse cap: a change-plan burns a lifetime slot (fresh Stripe sub).
    if (profile && profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP) {
      return errorResponse("CONFLICT", "lifetime_subscription_cap_reached", 409);
    }
    // No-op guard: same tier AND same period. Cheap to enforce here so the
    // UI can stay dumb and we don't create a pointless duplicate sub.
    if (
      subscription.tier === payload.tier &&
      subscription.billing_period === payload.billingPeriod
    ) {
      return errorResponse("CONFLICT", "plan_unchanged", 409);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const priceId = resolvePriceId(payload.tier, payload.billingPeriod);

    // Intentionally do NOT apply the intro-discount coupon on upgrade/
    // downgrade — first-cycle discounts are for brand-new customers only,
    // and granting them on change-plan would let users oscillate plans to
    // harvest the discount.
    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/dashboard/billing?planChanged=1`,
      cancelUrl: `${appUrl}/dashboard/billing`,
      customerEmail: user.email ?? undefined,
      metadata: {
        businessId: business.id,
        tier: payload.tier,
        billingPeriod: payload.billingPeriod,
        userId: user.userId,
        lifecycleAction: "changePlan",
        previousSubscriptionId: subscription.id
      }
    });

    return successResponse({ checkoutUrl: session.url });
  } catch (err) {
    return handleRouteError(err);
  }
}
