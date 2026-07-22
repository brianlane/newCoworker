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
 * The ACTIVE-booking lookup is the shared attendee-bookings adapter
 * (`lookupProviderBookingsForAttendee`, detail mode — one listing,
 * email-narrowed when known, invitees fetched for name + lineage, same call
 * pattern this module used before the extraction). The CANCELED scans stay
 * here: "recently canceled" is preamble-specific state no other consumer
 * wants, and Calendly's canceled-invitee matching is deliberately different
 * (a canceled invitee is exactly what it looks for).
 *
 * Calendly and Vagaro: both providers take bookings OUTSIDE the platform
 * (Calendly on calendly.com, Vagaro on the merchant's own booking page /
 * front desk), so both are invisible to the agent without this lookup; the
 * workspace providers' bookings are platform-created and already reachable
 * through the calendar tools. Vagaro reports `booked` and `canceled` only —
 * its API carries no reschedule lineage (no `old_invitee` equivalent), so a
 * moved appointment reads as `booked` at its new time. Everything here
 * FAILS OPEN to `none` — a provider hiccup must never delay or block a
 * reply. Consumed by POST /api/internal/contact-booking-context
 * (cron-bearer), which the sms-inbound-worker calls best-effort per
 * customer turn.
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
import {
  lookupProviderBookingsForAttendee,
  resolveCalendlyUserUri,
  ATTENDEE_BOOKING_EVENT_SCAN,
  ATTENDEE_BOOKING_INVITEE_FETCH_CAP,
  ATTENDEE_BOOKING_HORIZON_DAYS,
  type AttendeeBookingDeps,
  type UpcomingAttendeeBooking
} from "@/lib/calendar-tools/attendee-bookings";
import { calendlyEventUuid } from "@/lib/ai-flows/calendly-poll";
import { getActiveVagaroConnection } from "@/lib/db/vagaro-connections";
import { listVagaroAppointments, type VagaroAppointmentItem } from "@/lib/vagaro/client";
import { VAGARO_CANCELED_LIST_STATUS } from "@/lib/ai-flows/vagaro-poll";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Events scanned per listing (active, then canceled). */
export const BOOKING_CONTEXT_EVENT_SCAN = ATTENDEE_BOOKING_EVENT_SCAN;
/** Per-lookup cap on invitee fetches (both listings combined). */
export const BOOKING_CONTEXT_INVITEE_FETCH_CAP = ATTENDEE_BOOKING_INVITEE_FETCH_CAP;
/** How far back the CANCELED scan reaches — recent cancels/reschedules only.
 * (The active scan floors at NOW: only upcoming bookings are reported, and a
 * past-start active event must never shadow the real upcoming slot.) */
export const BOOKING_CONTEXT_BACK_DAYS = 7;
/** How far ahead an upcoming booking may start and still be reported. */
export const BOOKING_CONTEXT_HORIZON_DAYS = ATTENDEE_BOOKING_HORIZON_DAYS;

export type ContactBookingStatus = "booked" | "rescheduled" | "canceled" | "none";

export type ContactBookingContext = {
  status: ContactBookingStatus;
  /** One model-facing line for the reply preamble; null when status is none. */
  line: string | null;
};

export type ContactBookingContextDeps = AttendeeBookingDeps;

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

/** Whether a Vagaro appointment belongs to this contact (same tolerance). */
export function vagaroAppointmentMatchesContact(
  item: VagaroAppointmentItem,
  ids: { phoneDigits: string[]; email: string | null }
): boolean {
  return inviteeMatchesContact(
    {
      email: item.customerEmail ?? undefined,
      text_reminder_number: item.customerPhone ?? undefined
    },
    ids
  );
}

/**
 * The booking start rendered business-local WITH a named timezone — a raw
 * UTC ISO invites the model to misconvert silently, and timezone-less times
 * are the defect class that no-showed a Central-time lead told "3:00 PM"
 * for an Eastern-time call (KYP/Ayanna, Jul 20 2026). No timezone on file
 * degrades to honest UTC labeling; an unrecognized timezone string falls
 * back to the raw ISO rather than throwing.
 */
function formatBookingStartLocal(startIso: string, timezone: string | null | undefined): string {
  const tz = (timezone ?? "").trim() || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(startIso));
  } catch {
    return startIso;
  }
}

/** The preamble line for each non-none status (exported for the route tests). */
export function bookingContextLine(
  status: Exclude<ContactBookingStatus, "none">,
  event: { name: string; startIso: string },
  opts: { rescheduledAway?: boolean; timezone?: string | null } = {}
): string {
  const what = `"${event.name}" starting ${formatBookingStartLocal(event.startIso, opts.timezone)}`;
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
 * The CANCELED-events scan: list recent canceled events (invitee_email-
 * narrowed when the contact's email is known), then fetch invitees per
 * event until a match — bounded by the turn's shared fetch budget. Returns
 * the first matching (event, invitee) pair, or null. Latest-slot-first so
 * the MOST RECENT cancellation is the one reported.
 */
async function scanForCanceledMatch(args: {
  businessId: string;
  conn: ResolvedVoiceConnection;
  request: NonNullable<ContactBookingContextDeps["request"]>;
  userUri: string;
  ids: { phoneDigits: string[]; email: string | null };
  budget: { remaining: number };
  nowMs: number;
}): Promise<{ event: ListedEvent; invitee: ListedInvitee } | null> {
  const { businessId, conn, request, userUri, ids, budget, nowMs } = args;
  const dayMs = 24 * 60 * 60_000;
  const params: Record<string, string> = {
    user: userUri,
    status: "canceled",
    sort: "start_time:desc",
    count: String(BOOKING_CONTEXT_EVENT_SCAN),
    min_start_time: new Date(nowMs - BOOKING_CONTEXT_BACK_DAYS * dayMs).toISOString(),
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
 * The texter's Vagaro booking state: the shared adapter's upcoming lookup
 * for `booked`, then a canceled-status listing for a recent cancel. No
 * reschedule lineage exists on Vagaro, so a moved appointment reads as
 * `booked` at its new time; a canceled listing the merchant's API doesn't
 * support simply throws into the caller's fail-open catch. Exported for the
 * route tests.
 */
export async function vagaroBookingContextForContact(
  businessId: string,
  conn: ResolvedVoiceConnection,
  ids: { phoneDigits: string[]; email: string | null },
  deps: ContactBookingContextDeps,
  timezone: string | null
): Promise<ContactBookingContext> {
  const getVagaroConnection = deps.getVagaroConnection ?? getActiveVagaroConnection;
  const listAppointments = deps.listAppointments ?? listVagaroAppointments;

  // Upcoming active booking first — the strongest, most actionable state.
  // The adapter answers soonest-first, so [0] is the contact's next slot.
  const upcoming = await lookupProviderBookingsForAttendee(
    businessId,
    conn,
    { phones: ids.phoneDigits, email: ids.email },
    deps,
    { mode: "detail" }
  );
  if (!upcoming.ok) return NONE;
  const active: UpcomingAttendeeBooking | undefined = upcoming.bookings[0];
  if (active) {
    return {
      status: "booked",
      line: bookingContextLine(
        "booked",
        { name: active.name ?? "Appointment", startIso: active.startIso },
        { timezone }
      )
    };
  }

  const vagaroConn = await getVagaroConnection(businessId);
  /* c8 ignore next 3 -- the adapter above already answered not_connected for
     a missing row; this re-read only guards a row deleted mid-lookup. */
  if (!vagaroConn) return NONE;

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60_000;

  // No upcoming booking: a recent canceled one is worth telling the agent
  // about. Most-recent-start first (the cancellation the preamble should
  // describe). Items whose status does not actually mark them canceled are
  // ignored — if the API ignored the status filter, misreporting a past
  // visit as "canceled" would be worse than answering none.
  const canceled = (
    await listAppointments(vagaroConn, {
      startIso: new Date(nowMs - BOOKING_CONTEXT_BACK_DAYS * dayMs).toISOString(),
      endIso: new Date(nowMs + BOOKING_CONTEXT_HORIZON_DAYS * dayMs).toISOString(),
      status: VAGARO_CANCELED_LIST_STATUS
    })
  )
    .filter((i) => i.cancelled && vagaroAppointmentMatchesContact(i, ids))
    .sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso))[0];
  if (canceled) {
    return {
      status: "canceled",
      line: bookingContextLine(
        "canceled",
        { name: canceled.serviceName ?? "Appointment", startIso: canceled.startIso },
        { rescheduledAway: false, timezone }
      )
    };
  }
  return NONE;
}

/**
 * The texter's booking state on the connected provider (Calendly or
 * Vagaro), as one preamble-ready line. Never throws; every failure mode
 * answers `none`.
 */
export async function contactBookingContextForPhone(
  businessId: string,
  phoneE164: string,
  deps: ContactBookingContextDeps = {},
  client?: SupabaseClient,
  /** Business timezone for rendering the booking start local (null = UTC). */
  timezone?: string | null
): Promise<ContactBookingContext> {
  const request = deps.request ?? calendlyRequest;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const getCachedUserUri = deps.getCachedUserUri ?? getActiveCalendlyConnectionUserUri;
  const persistUserUri = deps.persistUserUri ?? setCalendlyConnectionUserUri;

  try {
    const conn = await resolveConnection(businessId);
    if (!conn || (conn.provider !== "calendly" && conn.provider !== "vagaro")) return NONE;
    const db = client ?? (await createSupabaseServiceClient());
    const ids = await contactIdentifiers(db, businessId, phoneE164);
    if (ids.phoneDigits.length === 0 && !ids.email) return NONE;

    if (conn.provider === "vagaro") {
      return await vagaroBookingContextForContact(businessId, conn, ids, deps, timezone ?? null);
    }

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
    // The shared adapter's detail mode is this module's original scan: ONE
    // now-floored listing (email-narrowed when known — a past-start active
    // event must never shadow the upcoming slot, Bugbot Medium on PR #795),
    // invitees fetched for the event name and reschedule lineage. The budget
    // object is shared with the canceled scan below so the whole turn stays
    // within one fetch cap.
    const activeRes = await lookupProviderBookingsForAttendee(
      businessId,
      conn,
      { phones: ids.phoneDigits, email: ids.email },
      deps,
      { mode: "detail", budget, calendlyUserUri: userUri }
    );
    // A refused active listing reads as "no active found" (the canceled
    // scan below still runs) — the pre-extraction scan behaved the same.
    const active = activeRes.ok ? activeRes.bookings[0] : undefined;
    if (active && Date.parse(active.startIso) > nowMs) {
      // `rescheduled` (Calendly `old_invitee`) marks this booking as the
      // REPLACEMENT slot of a reschedule — exactly the state the agent kept
      // denying.
      const status = active.rescheduled ? "rescheduled" : "booked";
      return {
        status,
        line: bookingContextLine(
          status,
          {
            /* c8 ignore next 2 -- the Calendly adapter always names events
               ("Appointment" default); the fallback only type-narrows. */
            name: active.name ?? "Appointment",
            startIso: active.startIso
          },
          { timezone }
        )
      };
    }

    // No upcoming booking: a recent canceled one is worth telling the agent
    // about ("canceled, not rebooked" vs "rescheduled away").
    const canceled = await scanForCanceledMatch({
      businessId,
      conn,
      request,
      userUri,
      ids,
      budget,
      nowMs
    });
    if (canceled) {
      return {
        status: "canceled",
        line: bookingContextLine(
          "canceled",
          { name: canceled.event.name, startIso: canceled.event.start_time },
          { rescheduledAway: canceled.invitee.rescheduled === true, timezone }
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
