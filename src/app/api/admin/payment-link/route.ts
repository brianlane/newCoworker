/**
 * Admin: mint a Stripe Checkout link for a signup that has not paid, so an
 * operator can send it to the customer directly.
 *
 * Every gate and every price decision lives in
 * `src/lib/billing/signup-payment-link.ts`, shared with the coworker's own
 * payment-link capability, so an operator and an agent hand out the same
 * charge. This route is auth plus audit.
 */

import { requireAdmin } from "@/lib/auth";
import { createSignupPaymentLink } from "@/lib/billing/signup-payment-link";
import { logAdminAction } from "@/lib/admin/audit";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const schema = z.object({
  businessId: z.string().uuid(),
  /** Needed while the row still carries the onboarding sentinel email. */
  ownerEmail: z.string().email().optional()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = schema.parse(await request.json());

    const result = await createSignupPaymentLink({
      businessId: body.businessId,
      ownerEmail: body.ownerEmail
    });

    if (!result.ok) {
      // A refusal is a rule doing its job, so it reports as a 409 with the
      // rule's own wording rather than a generic failure.
      await logAdminAction({
        adminEmail: admin.email,
        action: "payment_link_refused",
        businessId: body.businessId,
        detail: { refusal: result.refusal }
      });
      return errorResponse("CONFLICT", result.message, 409);
    }

    await logAdminAction({
      adminEmail: admin.email,
      action: "payment_link_issued",
      businessId: body.businessId,
      detail: {
        tier: result.tier,
        billingPeriod: result.billingPeriod,
        sessionId: result.sessionId,
        reusedPendingSubscription: result.reusedPendingSubscription
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
