/**
 * POST /api/admin/force-refund
 *
 * Operator-initiated cancel-with-refund. Bypasses the customer-lifetime
 * refund eligibility gates (`profile.refund_used_at`,
 * `isWithinLifetimeRefundWindow`) that block the self-serve
 * `/api/billing/cancel` path so support can honor a refund for edge cases
 * — e.g. billing disputes, accidental charges, or a compromised account.
 *
 * Plan source §PR 10: "Add admin force-refund button + endpoint on the
 * per-business admin page".
 *
 * Behavior is otherwise identical to the self-serve cancel-with-refund:
 *   - Refund the latest Stripe charge.
 *   - Cancel the Stripe subscription (release schedule).
 *   - Take SSH backup + snapshot, stop + cancel Hostinger billing.
 *   - Flip the `subscriptions` row into the 30-day grace window so the
 *     customer doesn't get an abrupt data wipe; they can still restore
 *     from the backup via reactivation until `grace_ends_at`.
 *   - Append a `subscription_refunds` row via `record_refund` for a
 *     per-refund audit trail.
 *   - Stamp `customer_profiles.refund_used_at` IFF the customer had not
 *     previously used their lifetime refund. The DB write
 *     (`markRefundUsed`) is conditional on `refund_used_at IS NULL`, so a
 *     second admin force-refund against the same profile is a no-op on
 *     this column — the timestamp captures "first lifetime allowance
 *     consumption" and is intentionally never re-stamped.
 *
 * Refund-cap semantics (intentional asymmetry):
 *   - Self-serve `/api/billing/cancel` is gated by
 *     `profile.refund_used_at` + `isWithinLifetimeRefundWindow`, so once
 *     ANY refund has stamped that column the customer can never self-
 *     serve refund again.
 *   - This admin route deliberately bypasses BOTH gates so support can
 *     honor a refund for genuine edge cases. It has no per-customer cap;
 *     a third or fourth admin force-refund will succeed at Stripe and
 *     append a fresh `subscription_refunds` audit row each time. The
 *     audit trail is the operator-facing accountability surface, not a
 *     hard lock.
 */

import { z } from "zod";
import { after } from "next/server";
import { requireAdmin, findAuthUserIdByEmail } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import {
  planLifecycleAction,
  type LifecycleContext,
  type LifecyclePlan,
  type DbUpdateOp,
  type EmailOp,
  type StripeOp
} from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { upsertCustomerProfile } from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";

// Vercel Pro allows up to 300s. The admin force-refund flow's slow
// phase (SSH backup + Hostinger snapshot/stop/billing-cancel + owner
// emails) runs post-response via the split-phase executor, but we keep
// a generous ceiling as a safety net so the serverless function isn't
// torn down mid-background-work on large tenants. Without this we'd
// fall back to the platform default (10s on Hobby, ~15s on most Pro
// configs) and operators would see Stripe-refunded-but-VPS-still-alive
// states that the grace-sweep can't clean up immediately. Mirrors the
// `/api/billing/cancel` pattern.
export const maxDuration = 300;

const schema = z.object({
  businessId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    const body = schema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found", 404);
    }

    const ownerAuthUserId = business.owner_email
      ? (await findAuthUserIdByEmail(business.owner_email)) ?? undefined
      : undefined;

    const ctxRes = await loadLifecycleContextForBusiness(body.businessId, {
      ownerAuthUserId
    });
    if (!ctxRes.ok) {
      return errorResponse("NOT_FOUND", ctxRes.reason, 404);
    }

    // Defense-in-depth active-state guard. The admin UI gates the
    // button on `subscription.status === "active"`, but a direct POST
    // (operator browser-tabs lingering after a status flip, scripted
    // bulk-call, etc.) would otherwise fall through to the
    // profile-upsert + planner pipeline below. The planner's own
    // `subscription_not_active` rejection prevents the actual refund
    // from running, but only AFTER we've eagerly upserted a
    // customer_profiles row and stamped `business.customer_profile_id`
    // — wasted writes for pending and idempotency-noise for canceled.
    // Surface the precondition cleanly here so the UI can branch and
    // the audit log shows a single 409 instead of a tangled 409 chain.
    if (ctxRes.context.subscription.status !== "active") {
      logger.info("admin.force-refund rejected: subscription not active", {
        adminEmail: admin.email,
        businessId: body.businessId,
        status: ctxRes.context.subscription.status
      });
      return errorResponse("CONFLICT", "subscription_not_active", 409);
    }

    // Ensure we have a real customer_profile_id before planning. The
    // lifetime-once refund policy is enforced via
    // `customer_profiles.refund_used_at`; if neither the subscription row
    // nor the loaded context has a profile id, the planner can emit a
    // `mark_refund_used` op only against a synthetic id (which the plan
    // rewrite would then drop), silently waiving the policy. Upsert one
    // now using the business owner's email so the stamp lands on a real
    // row that will match any future profile merged for that email.
    let effectiveCtx: LifecycleContext = ctxRes.context;
    let profileIdForPlan: string | null =
      ctxRes.context.subscription.customer_profile_id ?? ctxRes.context.profile?.id ?? null;
    if (!profileIdForPlan) {
      if (!business.owner_email) {
        logger.warn("admin.force-refund: no owner_email to upsert customer profile", {
          adminEmail: admin.email,
          businessId: body.businessId
        });
        return errorResponse(
          "CONFLICT",
          "cannot_enforce_refund_policy_without_profile",
          409
        );
      }
      try {
        profileIdForPlan = await upsertCustomerProfile({
          email: business.owner_email,
          signupIp: null
        });
      } catch (err) {
        logger.error("admin.force-refund: failed to upsert customer profile", {
          adminEmail: admin.email,
          businessId: body.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Profile upsert failed", 500);
      }
      // Best-effort attach the profile id to the business row so later
      // self-serve lookups resolve the same id.
      try {
        await setBusinessCustomerProfile(body.businessId, profileIdForPlan);
      } catch (err) {
        logger.warn("admin.force-refund: setBusinessCustomerProfile failed (continuing)", {
          businessId: body.businessId,
          profileId: profileIdForPlan,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      // Thread the real profile id into the lifecycle context so the
      // planner's `cancelWithRefund` precondition check sees a profile
      // (and so the rewritten plan stamps `customer_profile_id` on the
      // `subscriptions` row for future self-serve lookups).
      effectiveCtx = {
        ...ctxRes.context,
        subscription: {
          ...ctxRes.context.subscription,
          customer_profile_id: profileIdForPlan
        }
      };
    }

    const plan = buildAdminForceRefundPlan(effectiveCtx);
    if (!plan.ok) {
      return errorResponse("CONFLICT", plan.reason, 409);
    }

    // Read from `ctxRes.vpsHost` (top-level) rather than
    // `effectiveCtx.vpsHost` / `ctxRes.context.vpsHost` to stay aligned
    // with every other lifecycle-plan caller (`/api/billing/cancel`,
    // `/reactivate`, the Stripe webhook, the grace-sweep cron). The
    // loader populates both today; pinning every executor caller to the
    // single top-level convention prevents a future loader-shape
    // refactor from silently dropping the field on the admin path.
    const extra = {
      businessId: body.businessId,
      vpsHost: ctxRes.vpsHost,
      customerProfileId: profileIdForPlan
    };

    // Split-phase execution mirroring `/api/billing/cancel`: the fast
    // phase (Stripe refund + Stripe cancel + DB updates) runs inline
    // so the operator gets a definitive yes/no on the refund and the
    // `subscriptions` row is flipped to canceled + grace_ends_at set
    // before we return. The slow phase (SSH backup, Hostinger
    // snapshot/stop/billing-cancel, owner emails) runs post-response
    // via `next/server` `after()` (Vercel `waitUntil` under the hood)
    // so the serverless runtime keeps the function alive long enough
    // for minutes-long teardown work — a synchronous `await` here
    // would otherwise time out on real tenants and leave Stripe
    // refunded but the VPS/Hostinger billing dangling. The grace-
    // sweep cron is the backstop for any individual Hostinger step
    // that fails mid-background.
    let fastResult;
    try {
      fastResult = await executeLifecyclePlanFastPhase(plan.plan, extra);
    } catch (err) {
      logger.error("admin.force-refund: fast-phase failed", {
        adminEmail: admin.email,
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Force refund failed; please retry", 500);
    }

    after(async () => {
      try {
        await executeLifecyclePlanSlowPhase(plan.plan, fastResult);
      } catch (err) {
        logger.error("admin.force-refund: slow-phase failed (background)", {
          adminEmail: admin.email,
          businessId: body.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    logger.info("admin.force-refund complete", {
      adminEmail: admin.email,
      businessId: body.businessId
    });

    return successResponse({ refunded: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}

/**
 * Build a cancel-with-refund plan even if the user has already consumed
 * their lifetime refund window. We do this by delegating to the planner
 * for the common "cancel_with_refund is blocked" case, then falling back
 * to the equivalent plan produced by flipping the `profile` into an
 * eligible snapshot just for the planner call. We never persist that
 * synthetic profile — the executor still stamps `refund_used_at` for
 * real, so subsequent self-serve attempts remain blocked as policy
 * requires.
 */
function buildAdminForceRefundPlan(
  ctx: LifecycleContext
): { ok: true; plan: LifecyclePlan } | { ok: false; reason: string } {
  // Guaranteed non-null by the route-level upsert-or-fail guard.
  const realProfileId = (ctx.subscription.customer_profile_id ?? ctx.profile?.id) as string;
  const primary = planLifecycleAction({ type: "cancelWithRefund" }, ctx);
  if (primary.ok) {
    return { ok: true, plan: asAdminForceRefundPlan(primary.plan, realProfileId) };
  }

  // If the only blocker is refund-window / already-used / missing profile,
  // rebuild ctx with a synthetic eligibility-green profile. For structural
  // blockers (subscription not active, no Stripe sub) we surface the
  // planner's reason straight through.
  if (
    primary.reason !== "refund_window_closed" &&
    primary.reason !== "refund_already_used" &&
    primary.reason !== "missing_context"
  ) {
    return { ok: false, reason: primary.reason };
  }

  const now = ctx.now ?? new Date();
  const syntheticProfile = {
    id: ctx.profile?.id ?? "admin-synthetic",
    normalized_email: ctx.profile?.normalized_email ?? "admin-synthetic@local",
    stripe_customer_id: ctx.profile?.stripe_customer_id ?? null,
    last_signup_ip: ctx.profile?.last_signup_ip ?? null,
    lifetime_subscription_count: ctx.profile?.lifetime_subscription_count ?? 0,
    refund_used_at: null as string | null,
    first_paid_at: now.toISOString() as string | null,
    email_verified_at: ctx.profile?.email_verified_at ?? null,
    created_at: ctx.profile?.created_at ?? now.toISOString(),
    updated_at: ctx.profile?.updated_at ?? now.toISOString()
  };
  const forced = planLifecycleAction(
    { type: "cancelWithRefund" },
    { ...ctx, profile: syntheticProfile }
  );
  if (!forced.ok) return { ok: false, reason: forced.reason };
  return { ok: true, plan: asAdminForceRefundPlan(forced.plan, realProfileId) };
}

function asAdminForceRefundPlan(plan: LifecyclePlan, profileId: string): LifecyclePlan {
  // The cancel-with-refund planner stamps `cancel_reason: "user_refund"` on
  // the subscription patch + cancel-confirmation email because the planner
  // is generic to self-serve + admin flows. When we re-use it for an
  // operator-initiated force-refund, rewrite every spot that labels intent
  // so the `subscriptions.cancel_reason` audit column, the GraceBanner
  // headline, and the cancel-confirmation email copy all attribute the
  // action to admin rather than the customer.
  //
  // `profileId` is required (non-null): the route guarantees we resolve a
  // real customer_profiles row BEFORE reaching this rewrite so
  // `mark_refund_used` always lands on a real row. The module docstring
  // explicitly promises "the executor still stamps `refund_used_at` for
  // real, so subsequent self-serve attempts remain blocked as policy
  // requires" — silently dropping the op because the profile is missing
  // would violate that guarantee.
  return {
    ...plan,
    stripeOps: plan.stripeOps.map((op): StripeOp =>
      op.type === "refund_latest_charge" ? { ...op, reason: "admin_force" } : op
    ),
    dbUpdates: plan.dbUpdates.map((op): DbUpdateOp => {
      if (op.type === "mark_refund_used") {
        return { ...op, profileId };
      }
      if (op.type === "record_refund") {
        return { ...op, profileId, reason: "admin_force" };
      }
      if (op.type === "update_subscription") {
        return {
          ...op,
          patch: {
            ...op.patch,
            customer_profile_id: profileId,
            cancel_reason: "admin_force"
          }
        };
      }
      return op;
    }),
    emailsToSend: plan.emailsToSend.map((op): EmailOp =>
      op.type === "send_cancel_confirmation" ? { ...op, reason: "admin_force" } : op
    )
  };
}
