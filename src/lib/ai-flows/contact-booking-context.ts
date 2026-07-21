/**
 * Contact booking context for the SMS agent's preamble.
 *
 * The sms-inbound-worker's reply context carries the contact's memory
 * rollup, AiFlow run context, and the cross-channel timeline — but nothing
 * about their calendar state. Calendly bookings, reschedules, and
 * cancellations happen on calendly.com, so when Tim Tsai asked "I did
 * propose a new time last week — was that received?" the model had nothing
 * to consult and confidently denied the reschedule (KYP, Jul 20 2026).
 *
 * This core answers "what is this texter's booking state?" for one phone
 * number, as ONE preformatted model-facing line:
 *   - booked:      an active future-start booking exists;
 *   - rescheduled: the active booking replaced an earlier one (the invitee
 *                  carries `old_invitee`);
 *   - canceled:    their booking in the recent window was canceled and no
 *                  active future booking replaced it (`rescheduled` on the
 *                  canceled invitee distinguishes "moved it" from "dropped
 *                  it");
 *   - none:        nothing found / not a Calendly tenant / lookup refused.
 *
 * Calendly only: the other providers' bookings are platform-created and
 * already reachable through the calendar tools; Calendly is the provider
 * whose self-serve booking changes were invisible. Everything here FAILS
 * OPEN to `none` — a Calendly hiccup must never delay or block a reply.
 * Consumed by POST /api/internal/contact-booking-context (cron-bearer),
 * which the sms-inbound-worker calls best-effort per customer turn.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { calendlyRequest } from "@/lib/calendar-tools/calendly";
import {
  getActiveCalendlyConnectionUserUri,
  setCalendlyConnectionUserUri
} from "@/lib/db/calendly-connections";
import { digitsOf, phoneDigitsMatch } from "@/lib/calendar-tools/phone-match";
import { resolveCalendlyUserUri, type BookingPrecheckDeps } from "@/lib/ai-flows/booking-precheck";
import { calendlyEventUuid } from "@/lib/ai-flows/calendly-poll";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Events scanned per listing (active, then canceled). */
export const BOOKING_CONTEXT_EVENT_SCAN = 25;
/** Per-lookup cap on invitee fetches (both listings combined). */
export const BOOKING_CONTEXT_INVITEE_FETCH_CAP = 10;
/** How far back the CANCELED scan reaches — recent cancels/reschedules only.
 * (The active scan floors at NOW: only upcoming bookings are reported, and a
 * past-start active event must never shadow the real upcoming slot.) */
export const BOOKING_CONTEXT_BACK_DAYS = 7;
/** How far ahead an upcoming booking may start and still be reported. */
export const BOOKING_CONTEXT_HORIZON_DAYS = 90;

export type ContactBookingStatus = "booked" | "rescheduled" | "canceled" | "none";

export type ContactBookingContext = {
  status: ContactBookingStatus;
  /** One model-facing line for the reply preamble; null when status is none. */
  line: string | null;
};

export type ContactBookingContextDeps = Pick<
  BookingPrecheckDeps,
  "request" | "resolveConnection" | "getCachedUserUri" | "persistUserUri"
>;

const NONE: ContactBookingContext = { status: "none", line: null };

type ListedEvent = { uri: string; name: string; start_time: string };

type ListedInvitee = {
  status?: string;
  email?: string;
  text_reminder_number?: string;
  rescheduled?: boolean;
  old_invitee?: string | null;
};

/** The contact's identity for invitee matching: phone digits + email. */
export async function contactIdentifiers(
  db: SupabaseClient,
  businessId: string,
  phoneE164: string
): Promise<{ phoneDigits: string[]; email: string | null }> {
  const digitSet = new Set<string>([digitsOf(phoneE164)].filter((d) => d.length > 0));
  let email: string | null = null;
  try {
    const { data, error } = await db
      .from("contacts")
      .select("customer_e164, alias_e164s, email")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phoneE164},alias_e164s.cs.{${phoneE164}}`)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as {
      customer_e164?: string | null;
      alias_e164s?: string[] | null;
      email?: string | null;
    } | null;
    for (const n of [row?.customer_e164 ?? "", ...(row?.alias_e164s ?? [])]) {
      const d = digitsOf(n);
      if (d.length > 0) digitSet.add(d);
    }
    const trimmed = (row?.email ?? "").trim().toLowerCase();
    if (trimmed.includes("@")) email = trimmed;
  } catch (err) {
    // Degrades to phone-only matching — a contacts hiccup never fails the
    // lookup, it just narrows it.
    logger.warn("contact booking context: contact lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return { phoneDigits: [...digitSet], email };
}

/** Whether an invitee is this contact (email or country-code-tolerant phone). */
export function inviteeMatchesContact(
  invitee: ListedInvitee,
  ids: { phoneDigits: string[]; email: string | null }
): boolean {
  const inviteeEmail = (invitee.email ?? "").trim().toLowerCase();
  if (ids.email && inviteeEmail && inviteeEmail === ids.email) return true;
  const inviteeDigits =
    typeof invitee.text_reminder_number === "string" ? digitsOf(invitee.text_reminder_number) : "";
  return (
    inviteeDigits.length > 0 && ids.phoneDigits.some((d) => phoneDigitsMatch(inviteeDigits, d))
  );
}

/** The preamble line for each non-none status (exported for the route tests). */
export function bookingContextLine(
  status: Exclude<ContactBookingStatus, "none">,
  event: { name: string; startIso: string },
  opts: { rescheduledAway?: boolean } = {}
): string {
  const what = `"${event.name}" starting ${event.startIso}`;
  if (status === "booked") {
    return `This contact has an upcoming booking: ${what}.`;
  }
  if (status === "rescheduled") {
    return (
      `This contact has an upcoming booking: ${what} — they RESCHEDULED it from an ` +
      `earlier time, so if they mention having moved or proposed a new time, this is it.`
    );
  }
  return opts.rescheduledAway
    ? `This contact rescheduled their ${what} booking away from that time; their new time was not found in the upcoming window.`
    : `This contact CANCELED their booking ${what} and has not rebooked.`;
}

/**
 * One status-filtered scheduled-events scan: list (invitee_email-narrowed
 * when the contact's email is known), then fetch invitees per event until a
 * match — bounded by the shared fetch budget. Returns the first matching
 * (event, invitee) pair, or null.
 */
async function scanForMatch(args: {
  businessId: string;
  conn: ResolvedVoiceConnection;
  request: NonNullable<ContactBookingContextDeps["request"]>;
  userUri: string;
  status: "active" | "canceled";
  ids: { phoneDigits: string[]; email: string | null };
  budget: { remaining: number };
  nowMs: number;
  /** Window floor for listed event STARTS (active: now — upcoming only). */
  minStartMs: number;
}): Promise<{ event: ListedEvent; invitee: ListedInvitee } | null> {
  const { businessId, conn, request, userUri, status, ids, budget, nowMs, minStartMs } = args;
  const dayMs = 24 * 60 * 60_000;
  const params: Record<string, string> = {
    user: userUri,
    status,
    // First match wins, so the sort decides WHICH booking is reported:
    // active → soonest upcoming slot; canceled → the most RECENT slot (the
    // cancellation the preamble should describe, not a week-old one).
    sort: status === "active" ? "start_time:asc" : "start_time:desc",
    count: String(BOOKING_CONTEXT_EVENT_SCAN),
    min_start_time: new Date(minStartMs).toISOString(),
    max_start_time: new Date(nowMs + BOOKING_CONTEXT_HORIZON_DAYS * dayMs).toISOString()
  };
  if (ids.email) params.invitee_email = ids.email;
  const listRes = await request(businessId, conn, {
    endpoint: "/scheduled_events",
    method: "GET",
    params
  });
  if (!listRes) return null;
  const listed = ((listRes.data as { collection?: Array<Partial<ListedEvent>> })?.collection ?? [])
    .filter(
      (e): e is ListedEvent =>
        typeof e?.uri === "string" &&
        e.uri.length > 0 &&
        typeof e.start_time === "string" &&
        e.start_time.length > 0
    )
    .map((e) => ({ ...e, name: typeof e.name === "string" ? e.name : "Appointment" }));
  for (const event of listed) {
    if (budget.remaining <= 0) return null;
    budget.remaining -= 1;
    const invRes = await request(businessId, conn, {
      endpoint: `/scheduled_events/${encodeURIComponent(calendlyEventUuid(event.uri))}/invitees`,
      method: "GET",
      params: { count: "10" }
    });
    // A refused invitee fetch degrades to "no match so far" — fail open.
    if (!invRes) continue;
    const invitees =
      ((invRes.data as { collection?: ListedInvitee[] })?.collection ?? []).filter(
        (i): i is ListedInvitee => i != null && typeof i === "object"
      );
    const match = invitees.find((i) => inviteeMatchesContact(i, ids));
    if (match) return { event, invitee: match };
  }
  return null;
}

/**
 * The texter's Calendly booking state, as one preamble-ready line. Never
 * throws; every failure mode answers `none`.
 */
export async function contactBookingContextForPhone(
  businessId: string,
  phoneE164: string,
  deps: ContactBookingContextDeps = {},
  client?: SupabaseClient
): Promise<ContactBookingContext> {
  const request = deps.request ?? calendlyRequest;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const getCachedUserUri = deps.getCachedUserUri ?? getActiveCalendlyConnectionUserUri;
  const persistUserUri = deps.persistUserUri ?? setCalendlyConnectionUserUri;

  try {
    const conn = await resolveConnection(businessId);
    if (!conn || conn.provider !== "calendly") return NONE;
    const db = client ?? (await createSupabaseServiceClient());
    const ids = await contactIdentifiers(db, businessId, phoneE164);
    if (ids.phoneDigits.length === 0 && !ids.email) return NONE;

    const userUri = await resolveCalendlyUserUri(
      businessId,
      conn,
      request,
      getCachedUserUri,
      persistUserUri
    );
    if (!userUri) return NONE;

    const nowMs = Date.now();
    const budget = { remaining: BOOKING_CONTEXT_INVITEE_FETCH_CAP };

    // Upcoming active booking first — the strongest, most actionable state.
    // The listing floor is NOW so an older still-active event (earlier today,
    // yesterday) can never shadow the contact's real upcoming slot (Bugbot
    // Medium on PR #795: first match wins, and past starts sort first).
    const active = await scanForMatch({
      businessId,
      conn,
      request,
      userUri,
      status: "active",
      ids,
      budget,
      nowMs,
      minStartMs: nowMs
    });
    if (active && Date.parse(active.event.start_time) > nowMs) {
      // `old_invitee` marks this booking as the REPLACEMENT slot of a
      // reschedule — exactly the state the agent kept denying.
      const status = active.invitee.old_invitee ? "rescheduled" : "booked";
      return {
        status,
        line: bookingContextLine(status, {
          name: active.event.name,
          startIso: active.event.start_time
        })
      };
    }

    // No upcoming booking: a recent canceled one is worth telling the agent
    // about ("canceled, not rebooked" vs "rescheduled away").
    const canceled = await scanForMatch({
      businessId,
      conn,
      request,
      userUri,
      status: "canceled",
      ids,
      budget,
      nowMs,
      minStartMs: nowMs - BOOKING_CONTEXT_BACK_DAYS * 24 * 60 * 60_000
    });
    if (canceled) {
      return {
        status: "canceled",
        line: bookingContextLine(
          "canceled",
          { name: canceled.event.name, startIso: canceled.event.start_time },
          { rescheduledAway: canceled.invitee.rescheduled === true }
        )
      };
    }
    return NONE;
  } catch (err) {
    logger.warn("contact booking context: lookup failed (answering none)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return NONE;
  }
}
