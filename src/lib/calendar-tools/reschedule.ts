import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import type { ResolvedVoiceConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import {
  bookingAttendeeKey,
  deleteBookingClaim,
  deleteBookingClaimsByEvent,
  findUpcomingBookingClaim,
  recordExternalBookingClaim,
  rescheduleBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import {
  resolveToolTimezone,
  wallClockInZone,
  type CalendarToolResult
} from "@/lib/calendar-tools/handlers";
import { logger } from "@/lib/logger";

/**
 * Appointment lifecycle beyond the initial booking (Truly feedback Issue 4,
 * 2026-07-13): a reschedule must UPDATE the existing provider event — the
 * provider then emails an updated invitation — and a cancellation must
 * delete it, producing exactly one cancellation email. Before these cores
 * existed, the model's only move was booking a second event and leaving the
 * first one standing.
 *
 * Scope (v1): Google + Microsoft via the Nango proxy — the providers where
 * bookCalendarAppointment creates real events. Calendly ("bookings" are
 * invitee-completed links), Vagaro, and CalDAV return `not_supported` so the
 * model hands off to the team instead of pretending.
 *
 * Event resolution: the `calendar_booking_dedupe` ledger row (stamped at
 * booking) is the primary key — no provider search needed. Bookings that
 * predate the ledger fall back to a provider-side search for the attendee's
 * phone/email marker in the event body (bookings always carry an
 * `Attendee:`/`Phone:`/`Email:` description).
 */

export type RescheduleAppointmentArgs = {
  newStartIso: string;
  newEndIso: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  timezone?: string;
};

export type CancelAppointmentArgs = {
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
};

type LocatedEvent = {
  eventId: string;
  /** Ledger row backing the event; null when found via provider search. */
  claimId: string | null;
};

/** How far ahead the provider-search fallback scans for the booking. */
const SEARCH_WINDOW_DAYS = 60;

type ProxyTarget = { connectionId: string; providerConfigKey: string };

function proxyTarget(conn: ResolvedVoiceConnection): ProxyTarget {
  return { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
}

/**
 * Provider-side fallback search for the attendee's next upcoming event.
 * Matches on the phone/email marker embedded in every booked event's
 * description. Null when there is no usable marker or nothing matches.
 */
async function searchProviderEvent(
  businessId: string,
  conn: ResolvedVoiceConnection,
  marker: string
): Promise<string | null> {
  if (!marker) return null;
  // Bounded, case-insensitive matching (Bugbot on PR #577):
  //  - case-insensitive because the caller may hold a lowercased email (the
  //    ledger key shape) while the event body stores the form's casing;
  //  - boundary-guarded because a raw substring would let one attendee's
  //    marker match inside a longer value ("joe@acme.com" inside
  //    "notjoe@acme.com", or an E.164 as the prefix of a longer number) and
  //    mutate the wrong event.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Lookahead allows a bare trailing period (sentence end) but rejects a
  // continuation like ".au" or further digits/letters.
  const markerRe = new RegExp(`(?<![\\w.+@])${escaped}(?!\\.?[\\w@])`, "i");
  const containsMarker = (haystack: string) => markerRe.test(haystack);
  const nowIso = new Date().toISOString();
  const endIso = new Date(Date.now() + SEARCH_WINDOW_DAYS * 86_400_000).toISOString();
  const shared = await getSharedCalendar(businessId);

  if (conn.provider === "google") {
    const calendarPaths = [
      ...(shared ? [`/calendar/v3/calendars/${encodeURIComponent(shared.calendarId)}/events`] : []),
      "/calendar/v3/calendars/primary/events"
    ];
    for (const endpoint of calendarPaths) {
      try {
        const res = await nangoProxyForBusiness(businessId, proxyTarget(conn), {
          endpoint,
          method: "GET",
          params: {
            q: marker,
            timeMin: nowIso,
            singleEvents: "true",
            orderBy: "startTime",
            // q already narrows server-side to marker matches; a generous
            // page keeps a busy calendar's valid booking from falling past
            // it without pagination (Bugbot on PR #577).
            maxResults: "50"
          }
        });
        const items =
          ((res?.data ?? null) as {
            items?: Array<{ id?: string; description?: string }>;
          } | null)?.items ?? [];
        // `q` is a loose full-text match — verify the marker actually sits in
        // the event description before mutating anything, mirroring the
        // Microsoft path, so a fuzzy hit can never reschedule/cancel someone
        // else's event (Bugbot on PR #577).
        const hit = items.find(
          (e) =>
            typeof e.id === "string" && e.id.length > 0 && containsMarker(e.description ?? "")
        );
        if (hit?.id) return hit.id;
      } catch (err) {
        logger.warn("calendar-tools/search: google lookup failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return null;
  }

  // Microsoft: calendarView carries bodyPreview; scan the shared calendar
  // (where bookings land) then the default calendar.
  const viewPaths = [
    ...(shared
      ? [`/v1.0/me/calendars/${encodeURIComponent(shared.calendarId)}/calendarView`]
      : []),
    "/v1.0/me/calendarView"
  ];
  for (const endpoint of viewPaths) {
    try {
      const res = await nangoProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint,
        method: "GET",
        params: {
          startDateTime: nowIso,
          endDateTime: endIso,
          // Full body, not just bodyPreview: booked events carry free-form
          // notes BEFORE the Attendee/Phone/Email marker lines, and Graph
          // previews are short — long notes would push the marker out of the
          // preview and make valid appointments unfindable (Bugbot on
          // PR #577). The marker (an E.164 or email) substring-matches even
          // when Graph returns the body HTML-wrapped.
          $select: "id,bodyPreview,body,start",
          $orderby: "start/dateTime",
          // A busy calendar can hold far more than a couple dozen upcoming
          // events in the window; a small page made valid bookings past it
          // unfindable (Bugbot on PR #577). One large page keeps the call
          // single-round-trip — the search is already scoped to 60 days.
          $top: "250"
        }
      });
      const items =
        ((res?.data ?? null) as {
          value?: Array<{
            id?: string;
            bodyPreview?: string;
            body?: { content?: string };
          }>;
        } | null)?.value ?? [];
      const hit = items.find(
        (e) =>
          typeof e.id === "string" &&
          e.id.length > 0 &&
          containsMarker(`${e.body?.content ?? ""}\n${e.bodyPreview ?? ""}`)
      );
      if (hit?.id) return hit.id;
    } catch (err) {
      logger.warn("calendar-tools/search: microsoft lookup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return null;
}

/** Ledger first, provider search second. */
async function locateUpcomingAppointment(
  businessId: string,
  conn: ResolvedVoiceConnection,
  attendeeKey: string,
  marker: string
): Promise<LocatedEvent | null> {
  const claim = await findUpcomingBookingClaim(businessId, attendeeKey);
  if (claim) return { eventId: claim.eventId, claimId: claim.id };
  const eventId = await searchProviderEvent(businessId, conn, marker);
  return eventId ? { eventId, claimId: null } : null;
}

/**
 * PATCH/DELETE a Google event without knowing its owning calendar: bookings
 * land on the shared NewCoworker calendar when it exists, else primary, so
 * try in that order and treat a per-calendar failure as "wrong calendar".
 * True when one attempt succeeded.
 */
async function mutateGoogleEvent(
  businessId: string,
  conn: ResolvedVoiceConnection,
  eventId: string,
  method: "PATCH" | "DELETE",
  data?: Record<string, unknown>
): Promise<boolean> {
  const shared = await getSharedCalendar(businessId);
  const calendarIds = [...(shared ? [shared.calendarId] : []), "primary"];
  for (const calendarId of calendarIds) {
    try {
      const res = await nangoProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        method,
        ...(data ? { data } : {})
      });
      if (res) return true;
    } catch (err) {
      logger.warn("calendar-tools/mutate: google attempt failed", {
        businessId,
        calendarId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return false;
}

const NOT_SUPPORTED_PROVIDERS = new Set(["calendly", "vagaro", "caldav"]);

/**
 * Move the attendee's upcoming appointment to a new time IN PLACE. The
 * provider sends the attendee an UPDATED invitation for the same event —
 * never a second invite plus a lingering original.
 */
export async function rescheduleCalendarAppointment(
  businessId: string,
  args: RescheduleAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  if (new Date(args.newEndIso).getTime() <= new Date(args.newStartIso).getTime()) {
    return { ok: false, detail: "invalid_window" };
  }
  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) return { ok: false, detail: "calendar_not_connected" };
    if (NOT_SUPPORTED_PROVIDERS.has(conn.provider)) {
      return { ok: false, detail: "reschedule_not_supported" };
    }

    const phone = (args.attendeePhone ?? fallbackPhone ?? "").trim();
    const marker = phone || (args.attendeeEmail ?? "").trim();
    const attendeeKey = bookingAttendeeKey(phone, args.attendeeEmail, args.attendeeName);
    const located = await locateUpcomingAppointment(businessId, conn, attendeeKey, marker);
    if (!located) return { ok: false, detail: "booking_not_found" };

    const eventTimezone = await resolveToolTimezone(businessId, args.timezone);
    const startInstant = new Date(args.newStartIso);
    const endInstant = new Date(args.newEndIso);

    if (conn.provider === "google") {
      const patched = await mutateGoogleEvent(businessId, conn, located.eventId, "PATCH", {
        start: { dateTime: startInstant.toISOString(), timeZone: eventTimezone },
        end: { dateTime: endInstant.toISOString(), timeZone: eventTimezone }
      });
      if (!patched) return { ok: false, detail: "calendar_reschedule_failed" };
    } else {
      const res = await nangoProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint: `/v1.0/me/events/${encodeURIComponent(located.eventId)}`,
        method: "PATCH",
        data: {
          start: { dateTime: wallClockInZone(startInstant, eventTimezone), timeZone: eventTimezone },
          end: { dateTime: wallClockInZone(endInstant, eventTimezone), timeZone: eventTimezone }
        }
      });
      // The connection resolved moments ago, so a falsy proxy response here
      // is a failed MUTATION, not a missing calendar — reporting
      // calendar_not_connected would steer the model to "you cannot change
      // any appointment" (Bugbot on PR #577).
      if (!res) return { ok: false, detail: "calendar_reschedule_failed" };
    }

    // Keep the slot ledger matching the provider event so a later duplicate
    // check / reschedule / cancel resolves without a provider search. For a
    // provider-search hit (no ledger row under OUR key), first drop any row
    // the event holds under a DIFFERENT attendee key — its old start would
    // otherwise linger as a phantom booked slot.
    if (located.claimId) {
      await rescheduleBookingClaim(
        businessId,
        attendeeKey,
        located.claimId,
        startInstant.toISOString()
      );
    } else {
      await deleteBookingClaimsByEvent(businessId, located.eventId);
      await recordExternalBookingClaim(
        businessId,
        attendeeKey,
        startInstant.toISOString(),
        located.eventId
      );
    }

    return {
      ok: true,
      data: {
        eventId: located.eventId,
        provider: conn.provider,
        startIso: startInstant.toISOString(),
        endIso: endInstant.toISOString(),
        rescheduled: true
      }
    };
  } catch (err) {
    logger.warn("calendar-tools/reschedule failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "calendar_reschedule_failed" };
  }
}

/**
 * Cancel the attendee's upcoming appointment: delete the provider event
 * (the provider emails ONE cancellation) and drop its ledger row.
 */
export async function cancelCalendarAppointment(
  businessId: string,
  args: CancelAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) return { ok: false, detail: "calendar_not_connected" };
    if (NOT_SUPPORTED_PROVIDERS.has(conn.provider)) {
      return { ok: false, detail: "cancel_not_supported" };
    }

    const phone = (args.attendeePhone ?? fallbackPhone ?? "").trim();
    const marker = phone || (args.attendeeEmail ?? "").trim();
    const attendeeKey = bookingAttendeeKey(phone, args.attendeeEmail, args.attendeeName);
    const located = await locateUpcomingAppointment(businessId, conn, attendeeKey, marker);
    if (!located) return { ok: false, detail: "booking_not_found" };

    if (conn.provider === "google") {
      const deleted = await mutateGoogleEvent(businessId, conn, located.eventId, "DELETE");
      if (!deleted) return { ok: false, detail: "calendar_cancel_failed" };
    } else {
      const res = await nangoProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint: `/v1.0/me/events/${encodeURIComponent(located.eventId)}`,
        method: "DELETE"
      });
      // Same rationale as the reschedule PATCH: the calendar exists — this
      // is a failed mutation, not a disconnected calendar.
      if (!res) return { ok: false, detail: "calendar_cancel_failed" };
    }

    // Ledger cleanup covers BOTH resolution paths: the caller's own claim row
    // (ledger hit) and any row recorded under a different attendee key
    // (provider-search hit) — a canceled slot must never survive as a
    // "booked" ledger entry under any key.
    if (located.claimId) {
      await deleteBookingClaim(located.claimId);
    } else {
      await deleteBookingClaimsByEvent(businessId, located.eventId);
    }

    return {
      ok: true,
      data: { eventId: located.eventId, provider: conn.provider, canceled: true }
    };
  } catch (err) {
    logger.warn("calendar-tools/cancel failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "calendar_cancel_failed" };
  }
}
