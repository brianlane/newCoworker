/**
 * Internal endpoint: pre-send Calendly booking check for one AiFlow run.
 *
 * The ai-flow-worker Edge Function POSTs { businessId, runId } here
 * synchronously before a run's FIRST communication step (only for flows
 * watching the `appointment_booked` goal). The core
 * (src/lib/ai-flows/booking-precheck.ts) answers whether the run's lead
 * already holds an active future-start Calendly booking, and on a hit fires
 * the standard goal machinery for the lead's OTHER parked runs; the worker
 * jumps its own claimed run in-process when `booked` comes back true.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape as the
 * other /api/internal/* endpoints. Everything inside fails open (booked:
 * false) so a Calendly hiccup can never block a lead's greeting; the
 * young-run booking-goal sweep remains the ~1-min safety net.
 */
import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { bookingPrecheckForRun } from "@/lib/ai-flows/booking-precheck";

// A check is 1-2 Calendly calls in the common (email) path and a bounded
// scan in the phone path; 30s is generous headroom.
export const maxDuration = 30;
export const runtime = "nodejs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  runId: z.string().uuid()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const { businessId, runId } = bodySchema.parse(await request.json());
    const result = await bookingPrecheckForRun(businessId, runId);
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
