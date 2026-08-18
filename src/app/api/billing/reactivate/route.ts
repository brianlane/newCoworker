/**
 * POST /api/billing/reactivate
 *
 * Two modes:
 *   * `undoPeriodEnd`, user previously clicked "End at period end"; this
 *     reverts Stripe's cancel_at_period_end flag + our DB mirror. Only
 *     valid while the sub is still `active`.
 *   * `resubscribe`, user is in `canceled_in_grace` and wants to come
 *     back. We produce a fresh Stripe Checkout URL (tier/period passed in).
 *     The actual reactivation is driven by the `checkout.session.completed`
 *     webhook, which dispatches a fresh provisioning run + SSH restore.
 */

import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  planLifecycleAction,
  isCanceledInGrace
} from "@/lib/billing/lifecycle";
import { executeLifecyclePlan, executeLifecyclePlanFastPhase } from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  createCheckoutSession,
  resolvePriceId
} from "@/lib/stripe/client";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  getCustomerProfileById,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { setBusinessCustomerProfile } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("undoPeriodEnd") }),
  z.object({
    mode: z.literal("resubscribe"),
    tier: z.enum(["starter", "standard"]).optional(),
    billingPeriod: z.enum(["monthly", "annual", "biennial"]).optional()
  })
]);

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
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0];
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    // Payer identity, NOT caller identity: under view-as the business is the
    // tenant's, so the auth user the lifecycle planner may tear down
    // (`delete_auth_user`) and the Stripe customer email must be the TENANT's.
    // Passing the operator's here would plan deletion of the OPERATOR's own
    // login while cancelling a customer (Bugbot High on PR #1420). The
    // `userId` in Stripe metadata stays the caller: its only reader stores it
    // as `consent_user_id`, so the actor is the honest answer there.
    const payer = await resolveViewAsTargetUser(user);
    if (!payer.email) {
      // Only reachable for a tenant row with no owner_email at all. Refuse
      // rather than fall back to the caller's address, which is what would
      // put the operator on a customer's billing record.
      return errorResponse("NOT_FOUND", "This business has no owner email on file", 404);
    }

    const ctxRes = await loadLifecycleContextForBusiness(business.id, {
      ownerAuthUserId: payer.userId ?? undefined
    });
    if (!ctxRes.ok) {
      return errorResponse("NOT_FOUND", ctxRes.reason, 404);
    }

    if (payload.mode === "undoPeriodEnd") {
      const planRes = planLifecycleAction(
        { type: "reactivate", mode: "undoPeriodEnd" },
        ctxRes.context
      );
      if (!planRes.ok) {
        return errorResponse("CONFLICT", planRes.reason, 409);
      }
      // Stripe + DB first, then Hostinger renew re-enable on the throwing
      // path. Clearing cancel_at_period_end before enable means a Hostinger
      // failure leaves posture free to auto-heal renew (tenant is live again)
      // instead of Stripe/DB disagreeing while posture skips heal.
      const extra = {
        businessId: business.id,
        vpsHost: ctxRes.vpsHost,
        customerProfileId: ctxRes.context.subscription.customer_profile_id
      };
      try {
        await executeLifecyclePlanFastPhase(planRes.plan, extra);
        await executeLifecyclePlan(
          {
            ...planRes.plan,
            stripeOps: [],
            dbUpdates: [],
            sshOps: [],
            telnyxOps: []
          },
          extra
        );
      } catch (err) {
        logger.error("lifecycle execute failed on /api/billing/reactivate undoPeriodEnd", {
          businessId: business.id,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Reactivation failed; please retry", 500);
      }
      return successResponse({ mode: "undoPeriodEnd" });
    }

    // resubscribe: allowed only during grace or for a canceled sub whose
    // grace hasn't been wiped yet. We still produce a fresh Stripe checkout
    // (no portal redirect) so the UX is consistent with new-signup.
    const inGrace = isCanceledInGrace(ctxRes.context.subscription);
    if (!inGrace) {
      return errorResponse("CONFLICT", "subscription_not_in_grace", 409);
    }

    // Abuse gate: resubscription is a new lifetime. Block the 4th+ one so a
    // serial-canceler can't keep cycling intro discounts.
    //
    // Fail closed when no profile can be resolved, previously this branch
    // read `ctxRes.context.profile && count >= CAP`, so a null profile
    // (pre-lifecycle business or transient readback failure) would
    // short-circuit to falsy and silently skip the cap, letting a
    // serial-canceler produce unlimited fresh Stripe checkout sessions.
    // Mirror the /api/admin/force-refund pattern: upsert a real profile
    // using the authenticated owner's email and attach it to the
    // subscription so the cap check lands on a real row.
    let resubscribeProfileId =
      ctxRes.context.subscription.customer_profile_id ?? ctxRes.context.profile?.id ?? null;
    let resubscribeLifetimeCount = ctxRes.context.profile?.lifetime_subscription_count ?? null;
    if (!resubscribeProfileId || resubscribeLifetimeCount === null) {
      try {
        resubscribeProfileId = await upsertCustomerProfile({
          email: payer.email,
          signupIp: null
        });
      } catch (err) {
        logger.error("reactivate resubscribe: failed to upsert customer profile", {
          businessId: business.id,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not verify subscription eligibility", 500);
      }
      try {
        await setBusinessCustomerProfile(business.id, resubscribeProfileId);
      } catch (err) {
        logger.warn("reactivate resubscribe: setBusinessCustomerProfile failed (continuing)", {
          businessId: business.id,
          profileId: resubscribeProfileId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      const refreshed = await getCustomerProfileById(resubscribeProfileId);
      if (!refreshed) {
        // Upsert just returned a real id; a null readback here is a
        // transient DB issue. Fail closed so we don't let a potentially
        // capped profile through unchecked.
        logger.warn("reactivate resubscribe: profile readback returned null post-upsert", {
          businessId: business.id,
          profileId: resubscribeProfileId
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Could not verify subscription eligibility", 500);
      }
      resubscribeLifetimeCount = refreshed.lifetime_subscription_count;
    }
    if (resubscribeLifetimeCount >= LIFETIME_SUBSCRIPTION_CAP) {
      return errorResponse("CONFLICT", "lifetime_subscription_cap_reached", 409);
    }

    const tier = payload.tier ?? ctxRes.context.subscription.tier;
    const billingPeriod = payload.billingPeriod ?? ctxRes.context.subscription.billing_period;
    if (tier !== "starter" && tier !== "standard") {
      return errorResponse("CONFLICT", "unsupported_reactivation_tier", 409);
    }
    if (
      billingPeriod !== "monthly" &&
      billingPeriod !== "annual" &&
      billingPeriod !== "biennial"
    ) {
      return errorResponse("CONFLICT", "unsupported_reactivation_period", 409);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const priceId = resolvePriceId(tier, billingPeriod);
    // Thread the resolved (possibly just-upserted) profile id through so
    // the webhook's resubscribe orchestrator can increment the lifetime
    // count against the same row we just cap-checked.
    const metadataProfileId =
      resubscribeProfileId ?? ctxRes.context.subscription.customer_profile_id ?? null;
    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/dashboard/billing?reactivated=1`,
      cancelUrl: `${appUrl}/dashboard/billing`,
      customerEmail: payer.email ?? undefined,
      metadata: {
        businessId: business.id,
        tier,
        billingPeriod,
        userId: user.userId,
        lifecycleAction: "resubscribe",
        ...(metadataProfileId ? { customerProfileId: metadataProfileId } : {})
      }
    });

    return successResponse({ mode: "resubscribe", checkoutUrl: session.url });
  } catch (err) {
    return handleRouteError(err);
  }
}
