/**
 * POST /api/billing/cancel
 *
 * Body: `{ "mode": "refund" | "period_end" }`
 *
 * The sole tenant-facing cancellation entry point. Mode-refund is only
 * permitted when the caller's profile still has the lifetime-once 30-day
 * guarantee available; the planner surfaces a typed error otherwise.
 *
 * This route does NOT reach into the Stripe customer portal — cancellation
 * is always driven through our own lifecycle engine so side effects (VPS
 * teardown, data backup, grace window, lifetime-refund bookkeeping) stay
 * consistent. The Stripe customer portal is configured (Stripe Dashboard
 * operator action) to hide its cancellation control.
 */

import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import { executeLifecyclePlan } from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  mode: z.enum(["refund", "period_end"])
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
    // same row the page renders. Without an explicit order, Postgres is
    // free to return any row and the API would silently target a
    // different subscription than the one the user sees.
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

    const action =
      payload.mode === "refund"
        ? ({ type: "cancelWithRefund" } as const)
        : ({ type: "cancelAtPeriodEnd" } as const);

    const planRes = planLifecycleAction(action, ctxRes.context);
    if (!planRes.ok) {
      // Surface typed planner errors as 409s so the UI can branch.
      return errorResponse("CONFLICT", planRes.reason, 409);
    }

    try {
      await executeLifecyclePlan(planRes.plan, {
        businessId: business.id,
        vpsHost: ctxRes.vpsHost,
        customerProfileId: ctxRes.context.subscription.customer_profile_id
      });
    } catch (err) {
      logger.error("lifecycle execute failed on /api/billing/cancel", {
        businessId: business.id,
        mode: payload.mode,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Cancellation failed; please retry", 500);
    }

    return successResponse({
      mode: payload.mode,
      graceEndsAt:
        payload.mode === "refund"
          ? ((planRes.plan.dbUpdates.find(
              (op) => op.type === "update_subscription"
            ) as { type: "update_subscription"; patch: { grace_ends_at?: string | null } } | undefined)
              ?.patch.grace_ends_at ?? null)
          : null
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
