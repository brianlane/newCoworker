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
import { sweepCalendlyBookingGoals } from "@/lib/ai-flows/calendly-booking-goals";

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
    // Calendly booking → appointment_booked goal sweep rides the same tick
    // (per-business failures already isolate inside; this guard keeps a
    // sweep-level failure from masking the poll result — bookings stay
    // fresh for the whole lookback, so the next tick retries).
    const bookingGoals = await sweepCalendlyBookingGoals().catch((err) => {
      console.error("aiflow-calendar-poll booking-goal sweep", err);
      return null;
    });
    return successResponse({ ...result, bookingGoals });
  } catch (err) {
    return handleRouteError(err);
  }
}
