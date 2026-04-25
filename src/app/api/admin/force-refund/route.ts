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
 *   - Stamp `customer_profiles.refund_used_at` so the lifetime-once
 *     guarantee stays enforced (even admin-granted refunds count).
 */

import { z } from "zod";
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
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

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

    const plan = buildAdminForceRefundPlan(ctxRes.context);
    if (!plan.ok) {
      return errorResponse("CONFLICT", plan.reason, 409);
    }

    await executeLifecyclePlan(plan.plan, {
      businessId: body.businessId,
      vpsHost: ctxRes.context.vpsHost,
      customerProfileId: ctxRes.context.subscription.customer_profile_id
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
  const realProfileId = ctx.subscription.customer_profile_id ?? ctx.profile?.id ?? null;
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

function asAdminForceRefundPlan(plan: LifecyclePlan, profileId: string | null): LifecyclePlan {
  // The cancel-with-refund planner stamps `cancel_reason: "user_refund"` on
  // the subscription patch + cancel-confirmation email because the planner
  // is generic to self-serve + admin flows. When we re-use it for an
  // operator-initiated force-refund, rewrite every spot that labels intent
  // so the `subscriptions.cancel_reason` audit column, the GraceBanner
  // headline, and the cancel-confirmation email copy all attribute the
  // action to admin rather than the customer.
  return {
    ...plan,
    stripeOps: plan.stripeOps.map((op): StripeOp =>
      op.type === "refund_latest_charge" ? { ...op, reason: "admin_force" } : op
    ),
    dbUpdates: plan.dbUpdates.flatMap((op): DbUpdateOp[] => {
      if (op.type === "mark_refund_used") {
        return profileId ? [{ ...op, profileId }] : [];
      }
      if (op.type === "record_refund") {
        return [{ ...op, profileId, reason: "admin_force" }];
      }
      if (op.type === "update_subscription") {
        return [
          {
            ...op,
            patch: {
              ...op.patch,
              customer_profile_id: profileId,
              cancel_reason: "admin_force"
            }
          }
        ];
      }
      return [op];
    }),
    emailsToSend: plan.emailsToSend.map((op): EmailOp =>
      op.type === "send_cancel_confirmation" ? { ...op, reason: "admin_force" } : op
    )
  };
}
