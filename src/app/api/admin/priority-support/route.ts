/**
 * POST /api/admin/priority-support
 *
 * Operator controls for the $400/month priority support add-on.
 *
 *   pay_link  generate the tenant's Checkout URL to send them
 *   comp      grant a coverage window with NO charge, or clear one
 *   cancel    wind the paid subscription down at period end
 *
 * There is deliberately no "start billing them now" action. The card on file
 * was collected under the MEMBERSHIP's subscription mandate, which does not
 * cover starting a second recurring charge on the tenant's behalf, so the
 * owner has to complete Checkout themselves. That is the same call auto-reload
 * made, and the same shape as admin-authored white-glove offers: the admin
 * authors it, the owner pays it.
 */
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  getBusiness,
  setPrioritySupportUntil,
  clearPrioritySupportNudgeStamp
} from "@/lib/db/businesses";
import { logAdminAction } from "@/lib/admin/audit";
import {
  startPrioritySupport,
  cancelPrioritySupport,
  type PrioritySupportFailure
} from "@/lib/billing/priority-support";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

const bodySchema = z
  .object({
    businessId: z.string().uuid(),
    action: z.enum(["pay_link", "comp", "cancel"]),
    /** ISO date for `comp`; null clears the window entirely. */
    compUntil: z.string().datetime().nullable().optional()
  })
  .refine((v) => v.action !== "comp" || v.compUntil !== undefined, {
    message: "compUntil is required for the comp action (null clears the window)"
  });

/** Two years out. Guards a fat-fingered year the way MAX_HORIZON_MS does. */
const MAX_COMP_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function failureResponse(reason: PrioritySupportFailure): NextResponse {
  switch (reason) {
    case "not_purchasable_for_tier":
      return errorResponse(
        "VALIDATION_ERROR",
        "Enterprise tenants already hold a permanent priority support window"
      );
    case "already_subscribed":
      return errorResponse("CONFLICT", "This business already has priority support", 409);
    case "no_active_membership":
      return errorResponse("CONFLICT", "This business has no active subscription", 409);
    case "not_subscribed":
      return errorResponse("NOT_FOUND", "This business has no priority support subscription");
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = bodySchema.parse(await request.json());

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    if (body.action === "comp") {
      let until: Date | null = null;
      if (body.compUntil) {
        until = new Date(body.compUntil);
        if (Number.isNaN(until.getTime())) {
          return errorResponse("VALIDATION_ERROR", "compUntil is not a valid date");
        }
        if (until.getTime() > Date.now() + MAX_COMP_HORIZON_MS) {
          return errorResponse("VALIDATION_ERROR", "compUntil is more than two years out");
        }
      }
      // Deliberately the NON-monotonic writer: an operator must be able to
      // shorten or clear a window set by mistake, which extendPrioritySupport
      // (the payment path) refuses to do by design.
      await setPrioritySupportUntil(body.businessId, until);
      // A comp opens a NEW coverage window, so the expiry warning has to be
      // armed again. Without this, a tenant who was already warned once keeps
      // their old stamp and the sweep skips them forever, so the comped window
      // lapses silently.
      if (until) await clearPrioritySupportNudgeStamp(body.businessId);
      await logAdminAction({
        adminEmail: admin.email,
        action: "priority_support_comp",
        businessId: body.businessId,
        detail: { until: until ? until.toISOString() : null }
      });
      return successResponse({ ok: true, until: until ? until.toISOString() : null });
    }

    if (body.action === "cancel") {
      const result = await cancelPrioritySupport(body.businessId);
      if (!result.ok) return failureResponse(result.reason);
      await logAdminAction({
        adminEmail: admin.email,
        action: "priority_support_cancel",
        businessId: body.businessId,
        detail: { coverageEndsAt: result.value.coverageEndsAt }
      });
      return successResponse({ ok: true, coverageEndsAt: result.value.coverageEndsAt });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const result = await startPrioritySupport({
      businessId: body.businessId,
      tier: business.tier,
      // The OWNER pays, so Checkout opens under their address, never the
      // operator's, even though the operator generated the link.
      actorEmail: business.owner_email,
      successUrl: `${appUrl}/dashboard/billing?prioritySupport=success`,
      cancelUrl: `${appUrl}/dashboard/billing?prioritySupport=cancelled`
    });
    if (!result.ok) return failureResponse(result.reason);

    await logAdminAction({
      adminEmail: admin.email,
      action: "priority_support_pay_link",
      businessId: body.businessId,
      detail: { resumed: result.value.kind === "resumed" }
    });
    if (result.value.kind === "resumed") {
      return successResponse({ ok: true, resumed: true });
    }
    return successResponse({ ok: true, checkoutUrl: result.value.checkoutUrl });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
