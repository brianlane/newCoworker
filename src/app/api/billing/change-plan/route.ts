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
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  getCustomerProfileById,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { setBusinessCustomerProfile } from "@/lib/db/businesses";
import { isCommitmentElapsed, updateSubscription } from "@/lib/db/subscriptions";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  createCheckoutSession,
  getStripe,
  resolvePriceId
} from "@/lib/stripe/client";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import { resolveMembershipPackAddons } from "@/lib/billing/membership-pack-addons";
import { logger } from "@/lib/logger";

const packQtySchema = z.object({
  packId: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(20)
});

const bodySchema = z.object({
  tier: z.enum(["starter", "standard"]),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]),
  voicePacks: z.array(packQtySchema).max(10).optional(),
  smsPacks: z.array(packQtySchema).max(10).optional(),
  chatPacks: z.array(packQtySchema).max(10).optional()
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
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0];
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    // Payer identity, NOT caller identity. The business resolves through the
    // view-as pin, so an admin impersonating a tenant acts on the tenant's
    // subscription, and every field that names WHOSE ACCOUNT this is has to
    // follow: the Stripe customer email, the customer profile, and the auth
    // user the lifecycle planner may tear down. Leaving those on `user` would
    // attach the OPERATOR's profile to a customer's subscription and open
    // Checkout under the operator's address (Bugbot High on PR #1420).
    //
    // The `userId` handed to Stripe metadata is deliberately NOT retargeted:
    // its only reader stores it as `consent_user_id` (who authorized the
    // charge), so the caller is the honest answer there, same rule as the
    // clickwrap ledger.
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
    const { subscription, profile } = ctxRes.context;

    // changePlan is meaningful only on an active sub (grace/wiped go through
    // /reactivate resubscribe instead). Mirrors the planner's precondition.
    if (subscription.status !== "active") {
      return errorResponse("CONFLICT", "subscription_not_active", 409);
    }

    // Re-contract (Hostinger-consistent): once the paid commitment has
    // elapsed and the plan is rolling month-to-month at the renewal rate,
    // starting a NEW contract, even for the same tier/period, is a
    // legitimate action at the contract rate. It relaxes the plan-unchanged
    // guard below and exempts the lifetime abuse cap (a long-lived customer
    // re-committing every 1-2 years must never be blocked as an abuser).
    const recontractEligible =
      Boolean(subscription.stripe_subscription_id) && isCommitmentElapsed(subscription);
    // Abuse cap: a change-plan burns a lifetime slot (fresh Stripe sub).
    //
    // Fail closed when no profile can be resolved, previously this branch
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
          email: payer.email,
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
      // the subscription row, splitting lifetime accounting across
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
    if (changePlanLifetimeCount >= LIFETIME_SUBSCRIPTION_CAP && !recontractEligible) {
      return errorResponse("CONFLICT", "lifetime_subscription_cap_reached", 409);
    }
    // No-op guard: same tier AND same period. Cheap to enforce here so the
    // UI can stay dumb and we don't create a pointless duplicate sub. A
    // same-plan RE-CONTRACT after the commitment elapsed is explicitly
    // allowed, that's how a rolled-over customer gets back onto the
    // contract rate.
    if (
      subscription.tier === payload.tier &&
      subscription.billing_period === payload.billingPeriod &&
      !recontractEligible
    ) {
      return errorResponse("CONFLICT", "plan_unchanged", 409);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const priceId = resolvePriceId(payload.tier, payload.billingPeriod);

    // The country messaging surcharges follow the subscription they were
    // born on: carry one onto the replacement sub ONLY when the current
    // Stripe sub carries its flag (stamped by the signup checkout).
    // Grandfathered pre-fee tenants, and US tenants, never gain one here.
    // A metadata read failure fails toward NOT charging.
    let carryCanadaFee = false;
    let carryMexicoFee = false;
    if (subscription.stripe_subscription_id) {
      try {
        const stripeSub = await getStripe().subscriptions.retrieve(
          subscription.stripe_subscription_id
        );
        carryCanadaFee = stripeSub.metadata?.canadianMessagingFee === "1";
        carryMexicoFee = stripeSub.metadata?.mexicanMessagingFee === "1";
      } catch (err) {
        logger.warn(
          "change-plan: could not read old sub metadata for country fees (skipping fees)",
          {
            businessId: business.id,
            error: err instanceof Error ? err.message : String(err)
          }
        );
      }
    }

    // Intentionally do NOT apply the intro-discount coupon on upgrade/
    // downgrade, first-cycle discounts are for brand-new customers only,
    // and granting them on change-plan would let users oscillate plans to
    // harvest the discount.
    const packAddons = resolveMembershipPackAddons(
      {
        voicePacks: payload.voicePacks,
        smsPacks: payload.smsPacks,
        chatPacks: payload.chatPacks
      },
      payload.billingPeriod
    );
    if (!packAddons.ok) {
      return errorResponse("VALIDATION_ERROR", packAddons.error, 422);
    }

    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/dashboard/billing?planChanged=1`,
      cancelUrl: `${appUrl}/dashboard/billing`,
      customerEmail: payer.email ?? undefined,
      ...(carryCanadaFee
        ? {
            canadaFee: {
              monthlyCents: CANADA_MESSAGING_FEE_MONTHLY_CENTS,
              billingPeriod: payload.billingPeriod
            }
          }
        : {}),
      ...(carryMexicoFee
        ? {
            mexicoFee: {
              monthlyCents: MEXICO_MESSAGING_FEE_MONTHLY_CENTS,
              billingPeriod: payload.billingPeriod
            }
          }
        : {}),
      ...(packAddons.lines.length > 0
        ? {
            packAddonLines: packAddons.lines.map((line) => ({
              name: line.name,
              unitAmountCents: line.unitAmountCents,
              quantity: line.quantity,
              billingPeriod: payload.billingPeriod
            }))
          }
        : {}),
      metadata: {
        businessId: business.id,
        tier: payload.tier,
        billingPeriod: payload.billingPeriod,
        userId: user.userId,
        lifecycleAction: "changePlan",
        previousSubscriptionId: subscription.id,
        // The webhook orchestrator re-verifies this against the old sub row
        // before skipping the lifetime-count increment.
        ...(recontractEligible ? { recontract: "1" } : {}),
        ...(carryCanadaFee ? { canadianMessagingFee: "1" } : {}),
        ...(carryMexicoFee ? { mexicanMessagingFee: "1" } : {}),
        ...(changePlanProfileId ? { customerProfileId: changePlanProfileId } : {}),
        ...packAddons.metadata
      }
    });

    return successResponse({ checkoutUrl: session.url });
  } catch (err) {
    return handleRouteError(err);
  }
}
