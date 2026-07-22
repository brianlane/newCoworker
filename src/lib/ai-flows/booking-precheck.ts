/**
 * Pre-send booking check for AiFlow runs (Calendly + Vagaro).
 *
 * A lead who ALREADY booked must get zero flow texts — greeting included.
 * The 1/min booking-goal sweep and the provider webhooks only observe
 * bookings made while a run exists; a booking that predates the run (or the
 * observers themselves — Tim Tsai, Jul 18 2026) is invisible to both until
 * the young-run widening catches it ~1 min later, which can lose the race
 * against the run's first send. So the ai-flow-worker calls
 * POST /api/internal/aiflow-booking-precheck synchronously before a run's
 * FIRST communication step; this module is that route's core.
 *
 * Given a business + run, it answers "does this run's lead have an active
 * booking with a future start on the connected provider?" and, on a hit,
 * fires the standard `appointment_booked` goal machinery for the lead
 * (jumping any OTHER parked runs; the claimed run itself is `running` and
 * is jumped in-process by the worker when this returns booked).
 *
 * The provider lookup itself lives in the shared attendee-bookings module
 * (`lookupProviderBookingsForAttendee`, existence mode — one adapter per
 * provider, same call pattern this module used before the extraction); this
 * module keeps the run/flow gating, the goal firing, and the fail-open
 * reason mapping.
 *
 * Everything here FAILS OPEN by returning booked:false with a reason — the
 * worker sends as normal and the young-run sweep remains the safety net.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  lookupProviderBookingsForAttendee,
  ATTENDEE_BOOKING_EVENT_SCAN,
  ATTENDEE_BOOKING_INVITEE_FETCH_CAP,
  ATTENDEE_BOOKING_HORIZON_DAYS,
  type AttendeeBookingDeps
} from "@/lib/calendar-tools/attendee-bookings";
import {
  definitionWatchesBookingGoal,
  fireBookingGoalsForInvitees,
  inviteePhoneE164
} from "@/lib/ai-flows/calendly-booking-goals";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Upcoming events scanned by the phone-match fallback. */
export const PRECHECK_EVENT_SCAN = ATTENDEE_BOOKING_EVENT_SCAN;
/** Per-check cap on invitee fetches in the phone-match fallback. */
export const PRECHECK_INVITEE_FETCH_CAP = ATTENDEE_BOOKING_INVITEE_FETCH_CAP;
/** How far ahead a booking's start may be and still count. */
export const PRECHECK_HORIZON_DAYS = ATTENDEE_BOOKING_HORIZON_DAYS;

export type BookingPrecheckResult = {
  /** An active future-start booking exists for this run's lead. */
  booked: boolean;
  /** Parked runs the goal machinery fast-forwarded on a hit. */
  jumpedRuns: number;
  /** Why the check answered the way it did (diagnostics/telemetry). */
  reason:
    | "booked"
    | "no_booking_found"
    | "run_not_found"
    | "flow_without_booking_goal"
    | "provider_unsupported"
    | "no_lead_identifiers"
    | "calendly_refused"
    | "vagaro_refused";
};

export type BookingPrecheckDeps = AttendeeBookingDeps & {
  /** Injectable goal-firing helper (tests). */
  fireGoals?: typeof fireBookingGoalsForInvitees;
};

type RunRow = {
  id: string;
  flow_id: string;
  context: Record<string, unknown> | null;
};

/** The lead's identities as the run context carries them. */
export function leadIdentifiersFromContext(context: Record<string, unknown> | null): {
  phones: string[];
  emails: string[];
} {
  const vars = (context?.vars ?? {}) as Record<string, unknown>;
  const trigger = (context?.trigger ?? {}) as Record<string, unknown>;
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const raw of [vars.lead_phone, trigger.from]) {
    if (typeof raw !== "string") continue;
    const e164 = inviteePhoneE164(raw);
    if (e164) phones.add(e164);
  }
  const email = typeof vars.lead_email === "string" ? vars.lead_email.trim().toLowerCase() : "";
  if (email.includes("@")) emails.add(email);
  return { phones: [...phones], emails: [...emails] };
}

/**
 * Does this run's lead hold an active future-start booking on the connected
 * provider (Calendly or Vagaro)? Fires the `appointment_booked` goal
 * machinery on a hit. Never throws for "expected" trouble — a refused
 * transport or missing rows degrade to booked:false so the caller sends as
 * normal.
 */
export async function bookingPrecheckForRun(
  businessId: string,
  runId: string,
  deps: BookingPrecheckDeps = {},
  client?: SupabaseClient
): Promise<BookingPrecheckResult> {
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const fireGoals = deps.fireGoals ?? fireBookingGoalsForInvitees;
  const db = client ?? (await createSupabaseServiceClient());

  const none = (reason: BookingPrecheckResult["reason"]): BookingPrecheckResult => ({
    booked: false,
    jumpedRuns: 0,
    reason
  });

  // The run must exist and belong to the business the bearer claims.
  const { data: runRow, error: runErr } = await db
    .from("ai_flow_runs")
    .select("id, flow_id, context")
    .eq("id", runId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (runErr || !runRow) return none("run_not_found");
  const run = runRow as RunRow;

  // Only flows that actually watch appointment_booked pay a Calendly call.
  const { data: flowRow, error: flowErr } = await db
    .from("ai_flows")
    .select("definition, enabled")
    .eq("id", run.flow_id)
    .maybeSingle();
  const flow = flowRow as { definition?: unknown; enabled?: boolean } | null;
  if (flowErr || !flow?.enabled || !definitionWatchesBookingGoal(flow.definition)) {
    return none("flow_without_booking_goal");
  }

  const conn = await resolveConnection(businessId);
  if (!conn || (conn.provider !== "calendly" && conn.provider !== "vagaro")) {
    return none("provider_unsupported");
  }
  const refusedReason = conn.provider === "vagaro" ? "vagaro_refused" : "calendly_refused";

  const { phones, emails } = leadIdentifiersFromContext(run.context);
  if (phones.length === 0 && emails.length === 0) return none("no_lead_identifiers");

  let booked = false;
  try {
    const res = await lookupProviderBookingsForAttendee(
      businessId,
      conn,
      { phones, email: emails[0] ?? null },
      deps,
      { mode: "existence" }
    );
    if (!res.ok) return none(refusedReason);
    booked = res.bookings.length > 0;
  } catch (err) {
    // Vagaro transport trouble surfaces as a throw (see the shared module's
    // failure contract); fail open exactly as before the extraction. A
    // throwing CALENDLY transport propagates, also as before — its
    // production transport signals trouble by returning null, so a throw is
    // an unexpected bug the route's error handling should surface.
    if (conn.provider !== "vagaro") throw err;
    logger.warn("booking precheck: vagaro lookup refused (failing open)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return none(refusedReason);
  }

  if (!booked) return none("no_booking_found");

  // Fire the standard goal machinery with the run's own lead identity: it
  // fans out over the matched contact row's numbers and jumps every OTHER
  // parked run for this lead (the claimed run is `running` — the worker
  // jumps it in-process on this result).
  const fired = await fireGoals(db, businessId, [
    {
      status: "active",
      ...(emails[0] ? { email: emails[0] } : {}),
      ...(phones[0] ? { text_reminder_number: phones[0] } : {})
    }
  ]).catch((err) => {
    logger.warn("booking precheck: goal firing failed (booked stands)", {
      businessId,
      runId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { goalsFired: 0, jumpedRuns: 0 };
  });

  await recordSystemLog({
    businessId,
    source: "aiflow",
    level: "info",
    event: "ai_flow_booking_precheck_hit",
    message:
      `A lead already had an upcoming ${conn.provider === "vagaro" ? "Vagaro" : "Calendly"} ` +
      "booking when their flow reached its first message; follow-ups were skipped",
    payload: { run_id: runId, jumped_runs: fired.jumpedRuns }
  });

  return { booked: true, jumpedRuns: fired.jumpedRuns, reason: "booked" };
}
