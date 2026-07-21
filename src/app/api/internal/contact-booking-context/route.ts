/**
 * Internal endpoint: one texter's Calendly booking state for the SMS agent.
 *
 * The sms-inbound-worker POSTs { businessId, phone } here best-effort before
 * building a customer reply's preamble; the core
 * (src/lib/ai-flows/contact-booking-context.ts) answers with a preformatted
 * "booking status" line — upcoming booking, rescheduled booking, or a recent
 * cancel — so the model stops confidently denying reschedules it cannot see
 * (KYP / Tim Tsai, Jul 20 2026). Non-Calendly tenants answer none after a
 * cheap connection lookup.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape as the
 * other /api/internal/* endpoints. Everything inside fails open (status
 * none, line null); the worker treats any error as "no booking context".
 */
import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { contactBookingContextForPhone } from "@/lib/ai-flows/contact-booking-context";

// A lookup is 1-3 Calendly calls plus a capped invitee scan; 30s is generous.
export const maxDuration = 30;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  phone: z.string().trim().min(4).max(20)
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const { businessId, phone } = bodySchema.parse(await request.json());
    const result = await contactBookingContextForPhone(businessId, phone);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
