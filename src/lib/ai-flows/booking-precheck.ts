/**
 * Pre-send Calendly booking check for AiFlow runs.
 *
 * A lead who ALREADY booked must get zero flow texts — greeting included.
 * The 1/min booking-goal sweep and the invitee.created webhook only observe
 * bookings made while a run exists; a booking that predates the run (or the
 * observers themselves — Tim Tsai, Jul 18 2026) is invisible to both until
 * the young-run widening catches it ~1 min later, which can lose the race
 * against the run's first send. So the ai-flow-worker calls
 * POST /api/internal/aiflow-booking-precheck synchronously before a run's
 * FIRST communication step; this module is that route's core.
 *
 * Given a business + run, it answers "does this run's lead have an active
 * Calendly booking with a future start?" and, on a hit, fires the standard
 * `appointment_booked` goal machinery for the lead (jumping any OTHER parked
 * runs; the claimed run itself is `running` and is jumped in-process by the
 * worker when this returns booked).
 *
 * Lookup order (bounded, cheapest first):
 *   1. `invitee_email`-filtered events listing — one call per lead email.
 *   2. Phone match: scan upcoming events (capped) and match each event's
 *      invitees' SMS-reminder numbers country-code-tolerantly.
 *
 * Everything here FAILS OPEN by returning booked:false with a reason — the
 * worker sends as normal and the young-run sweep remains the safety net.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  resolveCalendarConnection,
  CALENDLY_DIRECT_KEY,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { calendlyRequest, type CalendlyRequestConfig } from "@/lib/calendar-tools/calendly";
import {
  getActiveCalendlyConnectionUserUri,
  setCalendlyConnectionUserUri
} from "@/lib/db/calendly-connections";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";
import {
  definitionWatchesBookingGoal,
  fireBookingGoalsForInvitees,
  inviteePhoneE164
} from "@/lib/ai-flows/calendly-booking-goals";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Upcoming events scanned by the phone-match fallback. */
export const PRECHECK_EVENT_SCAN = 25;
/** Per-check cap on invitee fetches in the phone-match fallback. */
export const PRECHECK_INVITEE_FETCH_CAP = 10;
/** How far ahead a booking's start may be and still count. */
export const PRECHECK_HORIZON_DAYS = 90;

export type BookingPrecheckResult = {
  /** An active future-start Calendly booking exists for this run's lead. */
  booked: boolean;
  /** Parked runs the goal machinery fast-forwarded on a hit. */
  jumpedRuns: number;
  /** Why the check answered the way it did (diagnostics/telemetry). */
  reason:
    | "booked"
    | "no_booking_found"
    | "run_not_found"
    | "flow_without_booking_goal"
    | "not_calendly"
    | "no_lead_identifiers"
    | "calendly_refused";
};

export type BookingPrecheckDeps = {
  /** Injectable transport (tests). */
  request?: (
    businessId: string,
    conn: ResolvedVoiceConnection,
    config: CalendlyRequestConfig
  ) => Promise<{ data: unknown } | null>;
  /** Injectable connection resolver (tests). */
  resolveConnection?: (businessId: string) => Promise<ResolvedVoiceConnection | null>;
  /** Injectable goal-firing helper (tests). */
  fireGoals?: typeof fireBookingGoalsForInvitees;
  /** Injectable user-URI cache reads/writes (tests). */
  getCachedUserUri?: (businessId: string) => Promise<string | null>;
  persistUserUri?: (businessId: string, userUri: string) => Promise<void>;
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
 * Resolve the connected account's user URI, preferring the cached value on
 * the direct-PAT connection row (poller parity — saves the /users/me probe).
 * Null when the transport refuses.
 */
async function resolveUserUri(
  businessId: string,
  conn: ResolvedVoiceConnection,
  request: NonNullable<BookingPrecheckDeps["request"]>,
  getCachedUserUri: NonNullable<BookingPrecheckDeps["getCachedUserUri"]>,
  persistUserUri: NonNullable<BookingPrecheckDeps["persistUserUri"]>
): Promise<string | null> {
  const cacheable = conn.providerConfigKey === CALENDLY_DIRECT_KEY;
  if (cacheable) {
    try {
      const cached = await getCachedUserUri(businessId);
      if (cached) return cached;
    } catch (err) {
      logger.warn("booking precheck: user-uri cache read failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const res = await request(businessId, conn, { endpoint: "/users/me", method: "GET" });
  const uri = (res?.data as { resource?: { uri?: string } } | undefined)?.resource?.uri;
  if (typeof uri !== "string" || uri.length === 0) return null;
  if (cacheable) {
    try {
      await persistUserUri(businessId, uri);
    } catch (err) {
      logger.warn("booking precheck: user-uri cache write failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return uri;
}

/**
 * Does this run's lead hold an active future-start Calendly booking? Fires
 * the `appointment_booked` goal machinery on a hit. Never throws for
 * "expected" trouble — a refused transport or missing rows degrade to
 * booked:false so the caller sends as normal.
 */
export async function bookingPrecheckForRun(
  businessId: string,
  runId: string,
  deps: BookingPrecheckDeps = {},
  client?: SupabaseClient
): Promise<BookingPrecheckResult> {
  const request = deps.request ?? calendlyRequest;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const fireGoals = deps.fireGoals ?? fireBookingGoalsForInvitees;
  const getCachedUserUri = deps.getCachedUserUri ?? getActiveCalendlyConnectionUserUri;
  const persistUserUri = deps.persistUserUri ?? setCalendlyConnectionUserUri;
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
  if (!conn || conn.provider !== "calendly") return none("not_calendly");

  const { phones, emails } = leadIdentifiersFromContext(run.context);
  if (phones.length === 0 && emails.length === 0) return none("no_lead_identifiers");

  const userUri = await resolveUserUri(
    businessId,
    conn,
    request,
    getCachedUserUri,
    persistUserUri
  );
  if (!userUri) return none("calendly_refused");

  const nowMs = Date.now();
  const listParams = {
    user: userUri,
    status: "active",
    sort: "start_time:asc",
    min_start_time: new Date(nowMs).toISOString(),
    max_start_time: new Date(nowMs + PRECHECK_HORIZON_DAYS * 24 * 60 * 60_000).toISOString()
  };

  let booked = false;

  // 1) Email path: one `invitee_email`-filtered listing (a run carries at
  //    most one lead email).
  if (emails[0]) {
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params: { ...listParams, invitee_email: emails[0], count: "1" }
    });
    if (!res) return none("calendly_refused");
    const listed = (res.data as { collection?: unknown[] })?.collection ?? [];
    if (listed.length > 0) booked = true;
  }

  // 2) Phone path: scan upcoming events and match invitee SMS numbers
  //    country-code-tolerantly (Calendly may store national format).
  if (!booked && phones.length > 0) {
    const phoneDigits = phones.map((p) => digitsOf(p)).filter((d) => d.length > 0);
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params: { ...listParams, count: String(PRECHECK_EVENT_SCAN) }
    });
    if (!res) return none("calendly_refused");
    const events = ((res.data as { collection?: Array<{ uri?: string }> })?.collection ?? [])
      .filter((e): e is { uri: string } => typeof e?.uri === "string" && e.uri.length > 0);
    let fetched = 0;
    for (const event of events) {
      if (booked || fetched >= PRECHECK_INVITEE_FETCH_CAP) break;
      fetched += 1;
      const uuid = event.uri.slice(event.uri.lastIndexOf("/") + 1);
      const invRes = await request(businessId, conn, {
        endpoint: `/scheduled_events/${encodeURIComponent(uuid)}/invitees`,
        method: "GET",
        params: { count: "10" }
      });
      // A refused invitee fetch mid-scan degrades to "not found so far";
      // the remaining sweep/webhook observers still cover the lead.
      if (!invRes) continue;
      const invitees =
        (invRes.data as { collection?: Array<{ status?: string; text_reminder_number?: string }> })
          ?.collection ?? [];
      booked = invitees.some((i) => {
        if (i?.status === "canceled") return false;
        const inviteeDigits =
          typeof i.text_reminder_number === "string" ? digitsOf(i.text_reminder_number) : "";
        return (
          inviteeDigits.length > 0 &&
          phoneDigits.some((d) => phoneDigitsMatch(inviteeDigits, d))
        );
      });
    }
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
      "A lead already had an upcoming Calendly booking when their flow reached its first message; follow-ups were skipped",
    payload: { run_id: runId, jumped_runs: fired.jumpedRuns }
  });

  return { booked: true, jumpedRuns: fired.jumpedRuns, reason: "booked" };
}
