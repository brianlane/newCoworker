/**
 * Admin: mint a Stripe Checkout resubscribe link for a canceled-in-grace
 * tenant, so ops can send it without opening the Stripe Dashboard.
 *
 * Same session as owner Resume (`createAdminResubscribeCheckout`): existing
 * customer, current (or Standard) price, `lifecycleAction=resubscribe`
 * metadata so `checkout.session.completed` restores the subscriptions row.
 */

import { requireAdmin } from "@/lib/auth";
import { createAdminResubscribeCheckout } from "@/lib/billing/resubscribe-checkout";
import { logAdminAction } from "@/lib/admin/audit";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  tier: z.enum(["starter", "standard"]).optional(),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]).optional()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await request.json());

    const result = await createAdminResubscribeCheckout({
      businessId: body.businessId,
      ...(body.tier ? { tier: body.tier } : {}),
      ...(body.billingPeriod ? { billingPeriod: body.billingPeriod } : {})
    });

    if (!result.ok) {
      await logAdminAction({
        adminEmail: admin.email,
        action: "resubscribe_checkout_refused",
        businessId: body.businessId,
        detail: { refusal: result.refusal }
      });
      return errorResponse("CONFLICT", result.message, 409);
    }

    await logAdminAction({
      adminEmail: admin.email,
      action: "resubscribe_checkout_issued",
      businessId: body.businessId,
      detail: {
        tier: result.tier,
        billingPeriod: result.billingPeriod,
        sessionId: result.sessionId
      }
    });

    return successResponse({
      url: result.url,
      tier: result.tier,
      billingPeriod: result.billingPeriod,
      ownerEmail: result.ownerEmail
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
