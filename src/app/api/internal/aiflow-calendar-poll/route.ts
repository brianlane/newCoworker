/**
 * Internal endpoint that runs one calendar trigger poll.
 *
 * Kicked ~1/min by the ai-flow-worker Edge Function's cron tick (the worker
 * can't poll calendars itself — the Nango client + connection verification
 * live in this Next.js runtime), exactly like /api/internal/aiflow-email-poll.
 * Reads recently-created and soon-starting events for every calendar watched
 * by an enabled calendar-triggered flow and enqueues matching ai_flow_runs;
 * the worker then claims those on its next tick like any other queued run.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape and
 * secret as the other /api/internal/* endpoints.
 *
 * Self-healing: dedupe keys make repeat polls idempotent, so a failed or
 * skipped tick just means the event is picked up on the next one (the
 * created lookback and the event_start due window are much wider than the
 * poll interval).
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { pollCalendarTriggers } from "@/lib/ai-flows/calendar-poll";

// A poll is a few provider list calls per watched calendar; 60s is ample
// headroom without letting a hung provider pin the function.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await pollCalendarTriggers();
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
