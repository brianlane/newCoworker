/**
 * Calendly booking → `appointment_booked` Goal Event sweep.
 *
 * The `appointment_booked` goal event historically fired ONLY from
 * platform-created bookings (`calendar_book_appointment` on Google /
 * Microsoft / Vagaro / CalDAV — see calendar-tools/handlers.ts). Calendly
 * bookings happen on calendly.com (the tool can only hand out a scheduling
 * link), so a lead who booked was never observed and nurture flows kept
 * nudging them — KYP Ads' "just floating this back up" text landing AFTER
 * the lead had already booked (Jul 18 2026).
 *
 * This sweep runs on the same ~1/min tick as the calendar-trigger poller:
 * for every business that (a) has an enabled flow with a trunk goal step
 * watching `appointment_booked`, (b) has at least one jumpable run for such
 * a flow, and (c) resolves to a Calendly calendar connection, it lists
 * Calendly bookings created inside the poll lookback, resolves each active
 * invitee to lead phone number(s), and fires `applyGoalEvent` — parked
 * follow-up runs fast-forward past their remaining nudges exactly as if the
 * booking had been made through the platform tools.
 *
 * Idempotency: no seen-marker is needed. A booking stays "fresh" for the
 * whole lookback, so it re-fires each tick — but a run that already jumped
 * has no matching goal AHEAD of it anymore, so repeats no-op. (A brand-new
 * run started inside that window jumps immediately, which is the right
 * outcome: the lead has already booked, don't nurture them.)
 *
 * Young-run widening (booked-then-enrolled gap, Jul 19 2026): a run enrolled
 * AFTER its lead's booking aged out of the created lookback would otherwise
 * never see that booking (Tim Tsai booked ~10h before this sweep first
 * deployed and still got nudged). When a business has a jumpable run CREATED
 * inside the young-run window, that tick's firing set widens from "bookings
 * created inside the lookback" to "active bookings with a FUTURE start" —
 * one extra invitee fetch per upcoming booking, only while a young run
 * exists. Future-start-only is the stale-booking policy: an appointment
 * that already happened never silently skips a new flow's steps. The
 * synchronous pre-send gate in the worker (aiflow-booking-precheck) catches
 * the same case before the FIRST text; this widening is its fail-open
 * safety net.
 *
 * Invitee → phone resolution fires over BOTH identifiers when present (they
 * belong to the same person, and `applyGoalEvent` matches by exact E.164):
 *   - the SMS-reminder phone, normalized to E.164, unioned with the matched
 *     contact row's primary + merged aliases (the same fan-out the
 *     update_contact tag hook does — runs match the EXACT number they were
 *     triggered with, which after a profile merge may be any of them);
 *   - the invitee email, resolved through the business's contacts to that
 *     contact's numbers (a Calendly form often collects email but no phone).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { calendlyRequest, type CalendlyRequestConfig } from "@/lib/calendar-tools/calendly";
import {
  CALENDLY_CREATED_SCAN_BACK_DAYS,
  CALENDLY_CREATED_SCAN_DAYS,
  CALENDLY_POLL_PAGE_COUNT,
  calendlyEventUuid
} from "@/lib/ai-flows/calendly-poll";
import { CALENDAR_CREATED_LOOKBACK_MINUTES } from "@/lib/ai-flows/calendar-poll";
import { ensureCalendlyWebhookSubscription } from "@/lib/calendly/webhook-subscriptions";
import { findContactsByEmails } from "@/lib/db/contact-emails";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import {
  bookingPhoneE164,
  fireBookingGoalsForIdentities,
  type BookingGoalFireDeps,
  type BookingGoalFireResult
} from "@/lib/ai-flows/booking-goal-fire";
import {
  applyGoalEvent,
  goalStepMatches
} from "../../../supabase/functions/_shared/ai_flows/goal_events";
import type { FlowStep } from "../../../supabase/functions/_shared/ai_flows/types";

// Provider-neutral pieces moved to booking-goal-fire.ts; re-exported so the
// existing call sites (precheck, webhook receiver, one-shots) are unchanged.
export { contactNumbersFor } from "@/lib/ai-flows/booking-goal-fire";
export type { BookingGoalFireDeps, BookingGoalFireResult };

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Page size for the goal-flow listing — paged so no flow is silently skipped. */
export const BOOKING_GOAL_FLOW_PAGE = 100;

/**
 * Cap on per-tick invitee fetches per business. Set to the listing page size
 * (not the poller's smaller enrichment cap): a capped booking is only
 * retried while it is still inside the created lookback, so a sustained
 * burst bigger than the cap could age bookings out UNFIRED — with the cap
 * equal to everything one page can list, that requires >100 bookings created
 * within the lookback for one tenant (and the overflow is logged).
 */
export const BOOKING_GOAL_INVITEE_FETCH_CAP = 100;

/**
 * Run statuses a goal jump may touch — MUST mirror JUMPABLE_STATUSES in
 * _shared/ai_flows/goal_events.ts (not exported there; the sweep only uses
 * this to SKIP businesses with nothing jumpable, so drift would cost an
 * extra no-op Calendly call, never a wrong jump).
 */
export const BOOKING_GOAL_RUN_STATUSES = ["queued", "awaiting_reply", "awaiting_call"] as const;

/**
 * Blip-vs-outage escalation lookback for sweep failures (the sweep-scoped
 * twin of the calendar poller's logCalendarPollFailure): exactly wide
 * enough to hold the two previous ~1/min sweep ticks plus cron-jitter
 * slack, so "a prior failure inside the window" genuinely means "the last
 * tick(s) failed too". A healthy tick between failures writes no row and
 * pushes the older failure out of the window.
 */
export const BOOKING_SWEEP_FAILURE_ESCALATION_MS = 2 * 60_000 + 90_000;

/**
 * Record one per-business sweep failure with blip-vs-outage escalation:
 * the FIRST failure inside the window logs `warn` (a one-off upstream blip
 * — e.g. a single 2 AM "Calendly API timed out" — stays out of the admin
 * System Errors feed, which is error-only); a repeat inside the window
 * logs `error`. A failed/thrown lookback fails TOWARD `error` so a real
 * outage is never misfiled as a blip. No owner-alert arm: the calendar
 * poller polls the SAME Calendly connection every minute and already owns
 * the "reconnect your calendar" escalation for persistent connection
 * failures.
 */
async function logBookingSweepFailure(
  db: SupabaseClient,
  businessId: string,
  message: string
): Promise<void> {
  // Failure-path-only lookback: healthy ticks never pay this query.
  let priorFailures = 0;
  let lookbackFailed = false;
  try {
    const sinceIso = new Date(Date.now() - BOOKING_SWEEP_FAILURE_ESCALATION_MS).toISOString();
    const { data, error } = await db
      .from("system_logs")
      .select("id")
      .eq("business_id", businessId)
      .eq("event", "ai_flow_booking_goal_sweep_failed")
      .gte("created_at", sinceIso)
      .limit(1);
    if (error) throw new Error(error.message);
    priorFailures = (data ?? []).length;
  } catch (err) {
    lookbackFailed = true;
    console.error("booking goal sweep: failure lookback", err);
  }
  await recordSystemLog({
    businessId,
    source: "aiflow",
    level: lookbackFailed || priorFailures >= 1 ? "error" : "warn",
    event: "ai_flow_booking_goal_sweep_failed",
    message,
    payload: {}
  });
}

type GoalStep = Extract<FlowStep, { type: "goal" }>;

/**
 * True when a flow definition carries a trunk goal step watching
 * `appointment_booked`. Trunk-only matches the jump semantics: authoring
 * enforces trunk-only goals, and jumpRunToGoal skips nested ones anyway.
 */
export function definitionWatchesBookingGoal(definition: unknown): boolean {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some(
    (s) =>
      (s as { type?: unknown } | null)?.type === "goal" &&
      goalStepMatches(s as GoalStep, { kind: "appointment_booked" })
  );
}

/**
 * Whether a booking's `created_at` falls inside the sweep lookback — the
 * same window the calendar poller's event_created mode uses, so both
 * observers of "someone booked on Calendly" agree on freshness.
 */
export function bookingCreatedRecently(
  createdIso: string | undefined,
  nowMs: number
): boolean {
  if (!createdIso) return false;
  const createdMs = Date.parse(createdIso);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs >= nowMs - CALENDAR_CREATED_LOOKBACK_MINUTES * 60_000;
}

/**
 * Whether a booking's start is still ahead — the young-run widening only
 * fires goals for appointments that haven't happened yet (stale-booking
 * policy). Missing/unparseable starts are never "future".
 */
export function bookingStartsInFuture(
  startIso: string | undefined,
  nowMs: number
): boolean {
  if (!startIso) return false;
  const startMs = Date.parse(startIso);
  return Number.isFinite(startMs) && startMs > nowMs;
}

/**
 * How recently a jumpable run must have been created for the widened
 * (future-start) firing set to apply. Same window as the created lookback:
 * the pre-send gate checks the run's FIRST outward touch, which lands well
 * inside this window even behind an extraction step or a worker backlog.
 */
export const BOOKING_GOAL_YOUNG_RUN_MINUTES = CALENDAR_CREATED_LOOKBACK_MINUTES;

/** Whether a run row's created_at marks it "young" for the widening. */
export function runIsYoung(createdIso: string | undefined, nowMs: number): boolean {
  if (!createdIso) return false;
  const createdMs = Date.parse(createdIso);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs >= nowMs - BOOKING_GOAL_YOUNG_RUN_MINUTES * 60_000;
}

/**
 * Calendly's SMS-reminder phone → E.164 — the provider-neutral normalizer
 * under its historical Calendly-facing name (precheck + one-shot imports).
 */
export const inviteePhoneE164 = bookingPhoneE164;

/**
 * Invitee identity as Calendly reports it — the invitees listing item and
 * the invitee.created webhook payload share these fields, so the sweep and
 * the webhook receiver feed the same firing helper.
 */
export type CalendlyBookingInvitee = {
  status?: string;
  email?: string;
  text_reminder_number?: string;
};

type RawBooking = {
  uri?: string;
  created_at?: string;
  start_time?: string;
};

export type BookingGoalSweepResult = {
  /** Businesses with a booking-goal flow (before run/connection gating). */
  businesses: number;
  /** Businesses that were actually swept against Calendly. */
  swept: number;
  /** Bookings created inside the lookback across swept businesses. */
  bookings: number;
  /** applyGoalEvent invocations (unique numbers fired). */
  goalsFired: number;
  /** Runs fast-forwarded to their goal step. */
  jumpedRuns: number;
};

export type BookingGoalSweepDeps = {
  /** Injectable transport (tests). */
  request?: (
    businessId: string,
    conn: ResolvedVoiceConnection,
    config: CalendlyRequestConfig
  ) => Promise<{ data: unknown } | null>;
  /** Injectable connection resolver (tests). */
  resolveConnection?: (businessId: string) => Promise<ResolvedVoiceConnection | null>;
  /** Injectable goal applier (tests). */
  applyGoal?: typeof applyGoalEvent;
  /** Injectable email→contact resolver (tests). */
  findByEmails?: typeof findContactsByEmails;
  /** Injectable webhook-subscription upgrader (tests). */
  ensureWebhook?: typeof ensureCalendlyWebhookSubscription;
};

/**
 * Booked invitees → appointment_booked goal events. Shared by the polling
 * sweep and the real-time webhook receiver (src/lib/calendly/webhook-inbound.ts):
 * canceled invitees are skipped; the SMS-reminder phone (normalized to
 * E.164) and the invitee email (resolved through the business's contacts)
 * both seed the firing set, fanned out over each matched contact row's
 * primary + merged aliases — `applyGoalEvent` matches runs by exact E.164.
 * The fan-out itself lives in the provider-neutral
 * `fireBookingGoalsForIdentities` (booking-goal-fire.ts), shared with the
 * Vagaro observers.
 */
export async function fireBookingGoalsForInvitees(
  db: SupabaseClient,
  businessId: string,
  invitees: CalendlyBookingInvitee[],
  deps: BookingGoalFireDeps = {}
): Promise<BookingGoalFireResult> {
  // Raw API JSON may hold null entries; drop them with the canceled ones.
  const identities = invitees
    .filter((invitee) => invitee != null && invitee.status !== "canceled")
    .map((invitee) => ({
      phone: invitee.text_reminder_number ?? null,
      email: invitee.email ?? null
    }));
  return fireBookingGoalsForIdentities(db, businessId, identities, deps);
}

/**
 * Sweep every candidate business once: fresh Calendly bookings →
 * appointment_booked goal events. Throws only when the initial flow listing
 * fails; per-business failures land in system_logs and never block other
 * tenants (poller parity).
 */
export async function sweepCalendlyBookingGoals(
  client?: SupabaseClient,
  deps: BookingGoalSweepDeps = {}
): Promise<BookingGoalSweepResult> {
  const request = deps.request ?? calendlyRequest;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const applyGoal = deps.applyGoal ?? applyGoalEvent;
  const findByEmails = deps.findByEmails ?? findContactsByEmails;
  const ensureWebhook = deps.ensureWebhook ?? ensureCalendlyWebhookSubscription;
  const db = client ?? (await createSupabaseServiceClient());

  // Enabled flows with any trunk goal step (jsonb containment narrows the
  // scan server-side); the appointment_booked check runs in JS.
  const flowRows: Array<{ id: string; business_id: string; definition: unknown }> = [];
  for (let offset = 0; ; offset += BOOKING_GOAL_FLOW_PAGE) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, business_id, definition")
      .eq("enabled", true)
      .filter("definition->steps", "cs", '[{"type":"goal"}]')
      .order("id", { ascending: true })
      .range(offset, offset + BOOKING_GOAL_FLOW_PAGE - 1);
    if (error) {
      // Nothing listed yet → surface the failure. A LATER page failing must
      // not discard the flows already in hand (poller parity).
      if (flowRows.length === 0) {
        throw new Error(`sweepCalendlyBookingGoals: ${error.message}`);
      }
      console.error("sweepCalendlyBookingGoals flow listing page", error.message);
      break;
    }
    const batch = (data ?? []) as typeof flowRows;
    flowRows.push(...batch);
    if (batch.length < BOOKING_GOAL_FLOW_PAGE) break;
  }

  const byBusiness = new Map<string, string[]>();
  for (const row of flowRows) {
    if (!definitionWatchesBookingGoal(row.definition)) continue;
    byBusiness.set(row.business_id, [...(byBusiness.get(row.business_id) ?? []), row.id]);
  }

  const result: BookingGoalSweepResult = {
    businesses: byBusiness.size,
    swept: 0,
    bookings: 0,
    goalsFired: 0,
    jumpedRuns: 0
  };
  if (byBusiness.size === 0) return result;

  const nowMs = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const dayMs = 24 * 60 * 60_000;

  for (const [businessId, flowIds] of byBusiness) {
    try {
      // Anything jumpable at all? If not, skip the Calendly API entirely.
      // Newest-first so the same single row also answers "is any jumpable
      // run YOUNG?" — which switches this tick to the widened firing set.
      const { data: runRows, error: runErr } = await db
        .from("ai_flow_runs")
        .select("id, created_at")
        .eq("business_id", businessId)
        .in("flow_id", flowIds)
        .in("status", [...BOOKING_GOAL_RUN_STATUSES])
        .order("created_at", { ascending: false })
        .limit(1);
      if (runErr) throw new Error(`jumpable-run check: ${runErr.message}`);
      const newest = ((runRows ?? []) as Array<{ id: string; created_at?: string }>)[0];
      if (!newest) continue;
      const hasYoungRun = runIsYoung(newest.created_at, nowMs);

      // Only Calendly needs this observer: the other providers' bookings
      // are platform-created and fire the goal at the booking call site.
      const conn = await resolveConnection(businessId);
      if (!conn || conn.provider !== "calendly") continue;
      result.swept += 1;

      // Opportunistic real-time upgrade: businesses on a paid Calendly plan
      // get an invitee.created webhook subscription (seconds instead of the
      // poll's ~1-2 min); refused attempts are cooldown-gated inside, and
      // this sweep keeps running either way. Never throws.
      await ensureWebhook(businessId, conn, { request }, db);

      const userRes = await request(businessId, conn, { endpoint: "/users/me", method: "GET" });
      const userUri = (userRes?.data as { resource?: { uri?: string } } | undefined)?.resource
        ?.uri;
      if (typeof userUri !== "string" || userUri.length === 0) {
        throw new Error("calendar_not_connected");
      }

      // Same scan window as the poller's event_created mode: the listing
      // can only filter on START time, so scan upcoming (+ a short back
      // reach for retro bookings) and gate on created_at in JS.
      const listRes = await request(businessId, conn, {
        endpoint: "/scheduled_events",
        method: "GET",
        params: {
          user: userUri,
          status: "active",
          sort: "start_time:asc",
          count: String(CALENDLY_POLL_PAGE_COUNT),
          min_start_time: iso(nowMs - CALENDLY_CREATED_SCAN_BACK_DAYS * dayMs),
          max_start_time: iso(nowMs + CALENDLY_CREATED_SCAN_DAYS * dayMs)
        }
      });
      if (!listRes) throw new Error("calendar_not_connected");
      const listed = (listRes.data as { collection?: RawBooking[] })?.collection ?? [];
      if (listed.length >= CALENDLY_POLL_PAGE_COUNT) {
        // The single page may be truncating; fresh bookings could be hidden
        // behind it (bounded like the poller — surface it, don't page).
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_booking_goal_sweep_overflow",
          message:
            "Calendly booking-goal sweep listing filled a full page; some fresh bookings may be deferred",
          payload: { listed: listed.length }
        });
      }
      // Oldest created first: a booking about to age out of the lookback
      // must never be starved behind newer ones if the cap ever bites.
      // With a young run, ANY active future-start booking also fires — a
      // just-enrolled lead may have booked long before this run existed.
      const bookings = listed
        .filter(
          (b): b is RawBooking & { uri: string; created_at: string } =>
            typeof b?.uri === "string" &&
            b.uri.length > 0 &&
            typeof b.created_at === "string" &&
            (bookingCreatedRecently(b.created_at, nowMs) ||
              (hasYoungRun && bookingStartsInFuture(b.start_time, nowMs)))
        )
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      result.bookings += bookings.length;
      if (bookings.length === 0) continue;

      // Invitee identities across this business's fresh bookings. The cap
      // equals the listing page size, so every booking listed this tick can
      // be fetched this tick — a fresh booking cannot be starved past its
      // lookback by a same-tick burst (Bugbot on PR #742). A capped/refused
      // booking is retried next tick while it is still inside the lookback.
      const invitees: CalendlyBookingInvitee[] = [];
      let attempted = 0;
      for (const booking of bookings) {
        if (attempted >= BOOKING_GOAL_INVITEE_FETCH_CAP) {
          await recordSystemLog({
            businessId,
            source: "aiflow",
            level: "warn",
            event: "ai_flow_booking_goal_sweep_overflow",
            message:
              "Calendly booking-goal sweep hit its invitee-fetch cap this tick; remainder retried next tick",
            payload: { bookings: bookings.length }
          });
          break;
        }
        attempted += 1;
        const invRes = await request(businessId, conn, {
          endpoint: `/scheduled_events/${encodeURIComponent(
            calendlyEventUuid(booking.uri)
          )}/invitees`,
          method: "GET",
          params: { count: "10" }
        });
        if (!invRes) {
          logger.warn("booking goal sweep: invitee fetch refused; retried next tick", {
            businessId,
            bookingUri: booking.uri
          });
          continue;
        }
        invitees.push(
          ...(((invRes.data as { collection?: CalendlyBookingInvitee[] })?.collection) ?? [])
        );
      }

      const fired = await fireBookingGoalsForInvitees(db, businessId, invitees, {
        applyGoal,
        findByEmails
      });
      result.goalsFired += fired.goalsFired;
      result.jumpedRuns += fired.jumpedRuns;
      const jumped = fired.jumpedRuns;
      if (jumped > 0) {
        await recordSystemLog({
          businessId,
          source: "aiflow",
          level: "info",
          event: "ai_flow_goal_jumped_booking",
          message: `A new Calendly booking moved ${jumped} flow run(s) past their remaining follow-ups`,
          payload: { bookings: bookings.length, jumped_runs: jumped }
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logBookingSweepFailure(
        db,
        businessId,
        `Calendly booking-goal sweep failed: ${message}`
      );
    }
  }
  return result;
}
