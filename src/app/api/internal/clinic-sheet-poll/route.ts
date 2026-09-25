/**
 * Reads the BA Fitness clinic Google Sheets and hands a new patient row to
 * the clinic-sheet call flow. Kicked from the ai-flow-worker tick, same as
 * the email and calendar polls.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { pollClinicSheets } from "@/lib/clinic-sheets/poll";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await pollClinicSheets();
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
