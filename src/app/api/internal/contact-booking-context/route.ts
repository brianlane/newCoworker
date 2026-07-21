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
 * Auth, two accepted callers (mirrors /api/internal/meter-gemini-spend):
 *   - `Authorization: Bearer <INTERNAL_CRON_SECRET>` — the sms-inbound-worker
 *     and other platform edge callers;
 *   - a per-tenant gateway bearer bound to the posted businessId
 *     (`verifyGatewayTokenForBusiness`) — the voice bridge, which holds only
 *     its own box's token, so one tenant's bridge can never read another
 *     tenant's booking state.
 * Everything inside fails open (status none, line null); callers treat any
 * error as "no booking context".
 */
import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
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
  try {
    const { businessId, phone } = bodySchema.parse(await request.json());
    // The gateway check needs the businessId from the body, so both auth
    // arms run after parsing; the zod errors below reveal nothing sensitive.
    if (!assertCronAuth(request) && !(await verifyGatewayTokenForBusiness(request, businessId))) {
      return errorResponse("FORBIDDEN", "Invalid bearer", 403);
    }
    const result = await contactBookingContextForPhone(businessId, phone);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
