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
import {
  LIFETIME_SUBSCRIPTION_CAP,
  getCustomerProfileById,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { setBusinessCustomerProfile } from "@/lib/db/businesses";
import { updateSubscription } from "@/lib/db/subscriptions";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  createCheckoutSession,
  resolvePriceId
} from "@/lib/stripe/client";
import { logger } from "@/lib/logger";

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
    //
    // Fail closed when no profile can be resolved — previously this branch
    // read `profile && count >= CAP`, so a null profile (pre-lifecycle
    // business or transient readback failure) would short-circuit to
    // falsy and silently skip the cap. Mirror the /api/admin/force-refund
    // + /api/billing/reactivate pattern: upsert a real profile using the
    // authenticated owner's email and attach it to the subscription so
    // the cap check lands on a real row and subsequent lifetime-cap
    // enforcement points (webhook increment, reactivate) see it too.
    let changePlanProfileId = subscription.customer_profile_id ?? profile?.id ?? null;
    let changePlanLifetimeCount = profile?.lifetime_subscription_count ?? null;
    if (!changePlanProfileId || changePlanLifetimeCount === null) {
      const staleProfileId = subscription.customer_profile_id ?? null;
      try {
        changePlanProfileId = await upsertCustomerProfile({
          email: user.email,
          signupIp: null
        });
      } catch (err) {
        logger.error("change-plan: failed to upsert customer profile", {
          businessId: business.id,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not verify subscription eligibility", 500);
      }
      try {
        await setBusinessCustomerProfile(business.id, changePlanProfileId);
      } catch (err) {
        logger.warn("change-plan: setBusinessCustomerProfile failed (continuing)", {
          businessId: business.id,
          profileId: changePlanProfileId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      // Persist the resolved profile id back onto the subscription row
      // so the cap-check we're about to run, the new checkout's
      // metadata, and any later context loads (the webhook's
      // `runChangePlanFromCheckout` path keys off
      // `previousSubscriptionId` and re-reads `subscription.customer_profile_id`)
      // all see the same profile. Without this we'd cap-check the
      // freshly-upserted profile while the stale id remains pinned to
      // the subscription row — splitting lifetime accounting across
      // two profile rows and effectively bypassing the lifetime cap
      // when the linked profile was hard-deleted (GDPR purge, manual
      // cleanup) since the upsert-by-email returns a new id with
      // count=0. Best-effort: we already wrote the new id to
      // `business.customer_profile_id` above; if this update fails
      // the orchestrator's own re-upsert keeps lifetime accounting
      // self-consistent for the new sub, so log + continue rather
      // than failing the user's change-plan request.
      if (staleProfileId && staleProfileId !== changePlanProfileId) {
        try {
          await updateSubscription(subscription.id, {
            customer_profile_id: changePlanProfileId
          });
        } catch (err) {
          logger.warn("change-plan: failed to repoint subscription to resolved profile id (continuing)", {
            businessId: business.id,
            subscriptionRowId: subscription.id,
            staleProfileId,
            resolvedProfileId: changePlanProfileId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      const refreshed = await getCustomerProfileById(changePlanProfileId);
      if (!refreshed) {
        logger.warn("change-plan: profile readback returned null post-upsert", {
          businessId: business.id,
          profileId: changePlanProfileId
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not verify subscription eligibility", 500);
      }
      changePlanLifetimeCount = refreshed.lifetime_subscription_count;
    }
    if (changePlanLifetimeCount >= LIFETIME_SUBSCRIPTION_CAP) {
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
        previousSubscriptionId: subscription.id,
        ...(changePlanProfileId ? { customerProfileId: changePlanProfileId } : {})
      }
    });

    return successResponse({ checkoutUrl: session.url });
  } catch (err) {
    return handleRouteError(err);
  }
}
