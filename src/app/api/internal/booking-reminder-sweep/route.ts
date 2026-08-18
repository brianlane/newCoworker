/**
 * Internal endpoint that runs one booking-reminder pass.
 *
 * Kicked ~1/min by the ai-flow-worker's cron tick, beside the other trigger
 * polls. A pass is a single indexed read when no appointment is inside a
 * reminder window, which is most ticks.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`, same shape and
 * secret as the other /api/internal/* endpoints.
 *
 * Self-healing: every send is claimed on the booking row before it goes
 * out, so a failed or overlapping tick can never double-send; a late
 * reminder still goes (a late one beats none).
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { sweepBookingReminders } from "@/lib/booking-page/reminders";

// Sends are per booking (email through the tenant mailbox, SMS through
// Telnyx); the batch limit bounds the work well inside this.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
      /\/$/,
      ""
    );
    const result = await sweepBookingReminders(siteUrl);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
