/**
 * Internal endpoint that runs one calendar trigger poll.
 *
 * Kicked ~1/min by the ai-flow-worker Edge Function's cron tick (the worker
 * can't poll calendars itself, the Nango client + connection verification
 * live in this Next.js runtime), exactly like /api/internal/aiflow-email-poll.
 * Reads recently-created and soon-starting events for every calendar watched
 * by an enabled calendar-triggered flow and enqueues matching ai_flow_runs;
 * the worker then claims those on its next tick like any other queued run.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`, same shape and
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
import { handleObservedCancellation, sweepWaitlist } from "@/lib/calendar-tools/waitlist-fill";

// A poll is a few provider list calls per watched calendar; 60s is ample
// headroom without letting a hung provider pin the function.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    // Cadence gating lives inside pollCalendarTriggers (it needs the flow
    // list: short event_start leads keep per-minute polling). The booking-
    // goal sweep below stays per-minute either way: booking → goal-jump
    // latency is its point. Observed cancellations hand their vacated slot
    // (plus the canceled customer's identity, when derivable) to the
    // cancellation waitlist (callback because waitlist-fill imports the
    // booking core, which imports the poll module).
    const result = await pollCalendarTriggers(undefined, {
      onCanceledEvent: (businessId, startIso, attendee) =>
        handleObservedCancellation(businessId, startIso, attendee)
    });
    // Calendly booking → appointment_booked goal sweep rides the same tick
    // (per-business failures already isolate inside; this guard keeps a
    // sweep-level failure from masking the poll result, bookings stay
    // fresh for the whole lookback, so the next tick retries).
    const bookingGoals = await sweepCalendlyBookingGoals().catch((err) => {
      console.error("aiflow-calendar-poll booking-goal sweep", err);
      return null;
    });
    // Waitlist maintenance rides the same tick: expire lapsed entries and
    // pass expired offer holds to the next candidate. Never throws.
    const waitlist = await sweepWaitlist();
    return successResponse({ ...result, bookingGoals, waitlist });
  } catch (err) {
    return handleRouteError(err);
  }
}
