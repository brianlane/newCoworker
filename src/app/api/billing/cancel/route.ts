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
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { after } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { planLifecycleAction } from "@/lib/billing/lifecycle";
import {
  executeLifecyclePlan,
  executeLifecyclePlanFastPhase,
  executeLifecyclePlanSlowPhase
} from "@/lib/billing/lifecycle-executor";
import { loadLifecycleContextForBusiness } from "@/lib/billing/lifecycle-loader";
import { logger } from "@/lib/logger";

// Vercel Pro allows up to 300s. The cancel flow's slow phase (SSH backup
// + Hostinger teardown) runs post-response via the split-phase executor,
// but we keep a generous ceiling as a safety net so the serverless
// function doesn't get torn down mid-background-work on large tenants.
// (Hobby tier's 10s default is nowhere near enough even for the fast
// phase's Stripe refund + cancel round-trip.)
export const maxDuration = 300;

const bodySchema = z.object({
  mode: z.enum(["refund", "period_end"])
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
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }

    const payload = bodySchema.parse(await request.json());

    const db = await createSupabaseServiceClient();
    // Match the tenant-facing UI ordering (`/dashboard/billing`,
    // `/dashboard/layout.tsx`) so owners of multiple businesses act on the
    // same row the page renders. Without an explicit order, Postgres is
    // free to return any row and the API would silently target a
    // different subscription than the one the user sees.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
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

    // Placement gate (Terms §9): enterprise deployments on Canadian-region
    // or customer-supplied boxes (vps_provider ovh/byos) are excluded from
    // the self-serve 30-day money-back guarantee — the underlying OVH
    // infrastructure is non-refundable to the platform, and these
    // placements are governed by the enterprise agreement. Support can
    // still honor edge cases via /api/admin/force-refund, which is
    // deliberately not gated on placement.
    if (payload.mode === "refund") {
      const { resolveVpsProvider } = await import("@/lib/vps/provider");
      if (resolveVpsProvider(ctxRes.context.vpsProvider) !== "hostinger") {
        return errorResponse("CONFLICT", "refund_not_available_for_placement", 409);
      }
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

    const extra = {
      businessId: business.id,
      vpsHost: ctxRes.vpsHost,
      customerProfileId: ctxRes.context.subscription.customer_profile_id
    };

    if (payload.mode === "period_end") {
      // cancelAtPeriodEnd has NO SSH/Hostinger ops in its plan (VM keeps
      // running until the period actually ends), so the all-in-one path
      // is already fast enough for HTTP. Keep it simple.
      try {
        await executeLifecyclePlan(planRes.plan, extra);
      } catch (err) {
        logger.error("lifecycle execute failed on /api/billing/cancel", {
          businessId: business.id,
          mode: payload.mode,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse("INTERNAL_SERVER_ERROR", "Cancellation failed; please retry", 500);
      }
      return successResponse({ mode: payload.mode, graceEndsAt: null });
    }

    // Refund path: Stripe refund + cancel + DB flip are fast (seconds),
    // but SSH backup + Hostinger teardown are minutes-long. Split so the
    // user gets a definitive answer on the refund without risking an
    // HTTP timeout mid-teardown (which would leave Stripe refunded, DB
    // unclear, and the VM/billing dangling). See the screenshot-reported
    // bug "Synchronous SSH backup in cancellation API may time out".
    let fastResult;
    try {
      fastResult = await executeLifecyclePlanFastPhase(planRes.plan, extra);
    } catch (err) {
      logger.error("lifecycle fast-phase failed on /api/billing/cancel", {
        businessId: business.id,
        mode: payload.mode,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "Cancellation failed; please retry", 500);
    }

    // Kick off the slow phase (SSH backup, Hostinger snapshot + stop VM
    // + cancel billing, owner emails) without blocking the HTTP
    // response. We use Next.js `after` (Vercel `waitUntil` under the
    // hood on serverless) so the runtime is guaranteed to keep the
    // function alive until this work completes — a bare `void
    // promise.catch(...)` is NOT guaranteed to keep the serverless
    // function alive past the HTTP response, and a customer who got
    // refunded would otherwise be left with no SSH backup and a still-
    // running VM until the 30-day grace-sweep fires (and the sweep
    // doesn't take a backup, so their data would be permanently lost
    // on reactivation). Errors are fully internalised; the grace-sweep
    // cron is the backstop for any individual Hostinger step that
    // fails.
    after(async () => {
      try {
        await executeLifecyclePlanSlowPhase(planRes.plan, fastResult);
      } catch (err) {
        logger.error("lifecycle slow-phase failed on /api/billing/cancel (background)", {
          businessId: business.id,
          mode: payload.mode,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    return successResponse({
      mode: payload.mode,
      graceEndsAt:
        ((planRes.plan.dbUpdates.find(
          (op) => op.type === "update_subscription"
        ) as { type: "update_subscription"; patch: { grace_ends_at?: string | null } } | undefined)
          ?.patch.grace_ends_at ?? null)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
