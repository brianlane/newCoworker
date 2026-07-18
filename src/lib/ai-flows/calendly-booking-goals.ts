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
  applyGoalEvent,
  goalStepMatches
} from "../../../supabase/functions/_shared/ai_flows/goal_events";
import {
  isE164,
  normalizeNanpToE164
} from "../../../supabase/functions/_shared/ai_flows/engine";
import type { FlowStep } from "../../../supabase/functions/_shared/ai_flows/types";

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
 * Calendly's SMS-reminder phone → E.164 (already-E.164 kept as-is, loose
 * NANP normalized, anything else null) — the same tolerance as
 * fireGoalEvent's phone handling.
 */
export function inviteePhoneE164(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return isE164(trimmed) ? trimmed : normalizeNanpToE164(trimmed);
}

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
 * The contact row's full number set for one seed number (primary + merged
 * aliases + the seed itself), for the exact-match fan-out. Best-effort: a
 * lookup failure degrades to just the seed number.
 */
async function contactNumbersFor(
  db: SupabaseClient,
  businessId: string,
  seedE164: string
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("contacts")
      .select("customer_e164, alias_e164s")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${seedE164},alias_e164s.cs.{${seedE164}}`)
      .maybeSingle();
    if (error) {
      logger.warn("booking goal sweep: contact number union failed", {
        businessId,
        error: error.message
      });
      return [seedE164];
    }
    const row = data as { customer_e164?: string | null; alias_e164s?: string[] | null } | null;
    return [
      ...new Set(
        [seedE164, row?.customer_e164 ?? "", ...(row?.alias_e164s ?? [])].filter(Boolean)
      )
    ];
  } catch (err) {
    logger.warn("booking goal sweep: contact number union threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return [seedE164];
  }
}

export type BookingGoalFireDeps = {
  /** Injectable goal applier (tests). */
  applyGoal?: typeof applyGoalEvent;
  /** Injectable email→contact resolver (tests). */
  findByEmails?: typeof findContactsByEmails;
};

export type BookingGoalFireResult = {
  /** applyGoalEvent invocations (unique numbers fired). */
  goalsFired: number;
  /** Runs fast-forwarded to their goal step. */
  jumpedRuns: number;
};

/**
 * Booked invitees → appointment_booked goal events. Shared by the polling
 * sweep and the real-time webhook receiver (src/lib/calendly/webhook-inbound.ts):
 * canceled invitees are skipped; the SMS-reminder phone (normalized to
 * E.164) and the invitee email (resolved through the business's contacts)
 * both seed the firing set, fanned out over each matched contact row's
 * primary + merged aliases — `applyGoalEvent` matches runs by exact E.164.
 */
export async function fireBookingGoalsForInvitees(
  db: SupabaseClient,
  businessId: string,
  invitees: CalendlyBookingInvitee[],
  deps: BookingGoalFireDeps = {}
): Promise<BookingGoalFireResult> {
  const applyGoal = deps.applyGoal ?? applyGoalEvent;
  const findByEmails = deps.findByEmails ?? findContactsByEmails;

  const seedNumbers = new Set<string>();
  const seedEmails = new Set<string>();
  for (const invitee of invitees) {
    if (invitee?.status === "canceled") continue;
    const phone = inviteePhoneE164(invitee?.text_reminder_number);
    if (phone) seedNumbers.add(phone);
    const email = (invitee?.email ?? "").trim().toLowerCase();
    if (email) seedEmails.add(email);
  }

  // Email → contact primary number (one contacts scan per call).
  if (seedEmails.size > 0) {
    const linked = await findByEmails(businessId, [...seedEmails], db);
    for (const link of linked.values()) seedNumbers.add(link.customerE164);
  }

  // Fan out over the matched contact rows' full number sets, then fire.
  const fireNumbers = new Set<string>();
  for (const seed of seedNumbers) {
    for (const n of await contactNumbersFor(db, businessId, seed)) fireNumbers.add(n);
  }
  const result: BookingGoalFireResult = { goalsFired: 0, jumpedRuns: 0 };
  for (const number of fireNumbers) {
    result.goalsFired += 1;
    const { jumpedRuns } = await applyGoal(db, businessId, number, {
      kind: "appointment_booked"
    });
    result.jumpedRuns += jumpedRuns;
  }
  return result;
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
      const { data: runRows, error: runErr } = await db
        .from("ai_flow_runs")
        .select("id")
        .eq("business_id", businessId)
        .in("flow_id", flowIds)
        .in("status", [...BOOKING_GOAL_RUN_STATUSES])
        .limit(1);
      if (runErr) throw new Error(`jumpable-run check: ${runErr.message}`);
      if ((runRows ?? []).length === 0) continue;

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
      const bookings = listed
        .filter(
          (b): b is RawBooking & { uri: string; created_at: string } =>
            typeof b?.uri === "string" &&
            b.uri.length > 0 &&
            typeof b.created_at === "string" &&
            bookingCreatedRecently(b.created_at, nowMs)
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
      await recordSystemLog({
        businessId,
        source: "aiflow",
        level: "error",
        event: "ai_flow_booking_goal_sweep_failed",
        message: `Calendly booking-goal sweep failed: ${message}`,
        payload: {}
      });
    }
  }
  return result;
}
