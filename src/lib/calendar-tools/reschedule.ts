import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import type { ResolvedVoiceConnection } from "@/lib/voice-tools/connections";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import {
  bookingAttendeeKey,
  deleteBookingClaim,
  deleteBookingClaimsByEvent,
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone,
  findZoomMeetingIdByEvent,
  recordExternalBookingClaim,
  rescheduleBookingClaim
} from "@/lib/calendar-tools/booking-dedupe";
import {
  resolveToolTimezone,
  wallClockInZone,
  type CalendarToolResult
} from "@/lib/calendar-tools/handlers";
import {
  cancelCalendlyAppointment,
  createCalendlyRescheduleLink
} from "@/lib/calendar-tools/calendly";
import {
  cancelVagaroAppointment,
  rescheduleVagaroAppointment
} from "@/lib/calendar-tools/vagaro";
import {
  cancelAcuityAppointment,
  rescheduleAcuityAppointment
} from "@/lib/calendar-tools/acuity";
import {
  cancelCaldavAppointment,
  rescheduleCaldavAppointment
} from "@/lib/calendar-tools/caldav";
import {
  deleteZoomMeetingForBooking,
  updateZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import {
  moveSharedCalendarMirror,
  removeSharedCalendarMirror
} from "@/lib/calendar-tools/shared-calendar";
import { offerFreedSlot } from "@/lib/calendar-tools/waitlist-fill";
import {
  cancelWaitlistForAttendee,
  resolveWaitlistAfterBooking
} from "@/lib/calendar-tools/waitlist-resolve";
import { graphTimeIso } from "@/lib/ai-flows/calendar-poll";
import { logger } from "@/lib/logger";

/**
 * Appointment lifecycle beyond the initial booking (Truly feedback Issue 4,
 * 2026-07-13): a reschedule must UPDATE the existing provider event, the
 * provider then emails an updated invitation, and a cancellation must
 * delete it, producing exactly one cancellation email. Before these cores
 * existed, the model's only move was booking a second event and leaving the
 * first one standing.
 *
 * Provider coverage:
 *   - Google + Microsoft (Nango proxy): PATCH/DELETE the real event.
 *   - Vagaro: PUT/DELETE the appointment on the merchant's book. Resolution
 *     is ledger-only, Vagaro bookings stamp their appointment id into the
 *     dedupe ledger at booking time, and the v1 client has no
 *     search-by-customer surface.
 *   - Calendly: cancel is a real API cancellation; reschedule returns the
 *     invitee's own reschedule link (`reschedule_link_created`) because
 *     Calendly cannot move an event on the invitee's behalf, mirrors the
 *     `booking_link_created` booking contract.
 *   - CalDAV: the SAME .ics resource is rewritten in place (reschedule) or
 *     DELETEd (cancel). Resolution is ledger-only, like Vagaro, the client
 *     has no search-by-attendee surface.
 *
 * Event resolution: the `calendar_booking_dedupe` ledger row (stamped at
 * booking) is the primary key, no provider search needed. Bookings that
 * predate the ledger fall back to a provider-side search for the attendee's
 * phone/email marker in the event body (bookings always carry an
 * `Attendee:`/`Phone:`/`Email:` description).
 *
 * A NAME alone also resolves, because that is how owners ask ("move John
 * Smith's Tuesday 4pm"): the search matches the event's `Attendee:` line, so
 * it only ever hits an appointment we booked for that person. When a name
 * matches several upcoming appointments the caller's `appointmentStartIso`
 * picks one, and failing that the tools return `multiple_matches` with the
 * candidate start times so the model asks which one instead of guessing.
 */

export type RescheduleAppointmentArgs = {
  newStartIso: string;
  newEndIso: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  /**
   * The appointment's CURRENT start, when the caller named one ("move John's
   * Tuesday 4pm"). Disambiguates a name that matches several upcoming
   * appointments, and guards the ledger path: a claim at a different time
   * falls through to the provider search rather than moving the wrong one.
   */
  appointmentStartIso?: string;
  timezone?: string;
};

export type CancelAppointmentArgs = {
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  /** Same disambiguation contract as reschedule (see above). */
  appointmentStartIso?: string;
};

type LocatedEvent = {
  eventId: string;
  /** Ledger row backing the event; null when found via provider search. */
  claimId: string | null;
  /**
   * Zoom meeting created with the booking. Ledger hits read it off the
   * claim row; provider-search hits recover it from the event's row under
   * a different attendee key (findZoomMeetingIdByEvent). Reschedule/cancel
   * move/delete it with the event, best-effort.
   */
  zoomMeetingId: string | null;
  /**
   * The event's start, from the ledger claim or the provider search's
   * listing (null when neither carried one): this is the slot the
   * waitlist is told about when a cancel/reschedule frees it.
   */
  startAt: string | null;
};

/** How far ahead the provider-search fallback scans for the booking. */
const SEARCH_WINDOW_DAYS = 60;

type ProxyTarget = { connectionId: string; providerConfigKey: string };

function proxyTarget(conn: ResolvedVoiceConnection): ProxyTarget {
  return { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
}

type SearchedEvent = {
  eventId: string;
  /** The event's current start when the listing carried one (the slot a
   * cancel/reschedule frees for the waitlist); null otherwise. */
  startIso: string | null;
};

/**
 * How the provider search identifies the attendee's event. A phone/email
 * `marker` is exact and wins; `name` is the fallback for the way owners
 * actually talk ("move John Smith's Tuesday 4pm"), matched against the
 * `Attendee:` line every booked event carries.
 */
type SearchQuery = {
  /** Phone (E.164) or email; "" when the caller gave neither. */
  marker: string;
  /** Attendee name; "" when the caller gave none. */
  name: string;
};

/** Escape a user-supplied string for embedding in a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bounded, case-insensitive marker matching (Bugbot on PR #577):
 *  - case-insensitive because the caller may hold a lowercased email (the
 *    ledger key shape) while the event body stores the form's casing;
 *  - boundary-guarded because a raw substring would let one attendee's
 *    marker match inside a longer value ("joe@acme.com" inside
 *    "notjoe@acme.com", or an E.164 as the prefix of a longer number) and
 *    mutate the wrong event.
 */
function markerMatcher(marker: string): (haystack: string) => boolean {
  // Lookahead allows a bare trailing period (sentence end) but rejects a
  // continuation like ".au" or further digits/letters.
  const re = new RegExp(`(?<![\\w.+@])${escapeForRegExp(marker)}(?!\\.?[\\w@])`, "i");
  return (haystack) => re.test(haystack);
}

/**
 * Name matching is deliberately anchored to the `Attendee:` line rather than
 * a loose substring: it must only ever hit an appointment WE booked for that
 * person, never an owner's own meeting that happens to mention them. The
 * name must also END the line's value (whitespace, HTML tag, or line break
 * after it), so "John Smith" never matches "John Smithson".
 */
function attendeeNameMatcher(name: string): (haystack: string) => boolean {
  const re = new RegExp(`Attendee:\\s*${escapeForRegExp(name)}\\s*(?:$|<|\\r|\\n)`, "im");
  return (haystack) => re.test(haystack);
}

/**
 * Provider-side fallback search for the attendee's upcoming events. Returns
 * EVERY verified match, so a name that hits several appointments can be
 * disambiguated (or handed back to the model to ask "which one") instead of
 * silently mutating the first. Empty when the query carries no identity or
 * nothing matches.
 *
 * Marker mode keeps its first-hit short-circuit (an exact phone/email can
 * only mean one person, and stopping early saves a request); name mode scans
 * every calendar because the ambiguity contract needs every candidate.
 */
async function searchProviderEvents(
  businessId: string,
  conn: ResolvedVoiceConnection,
  query: SearchQuery
): Promise<SearchedEvent[]> {
  const marker = query.marker.trim();
  const name = query.name.trim();
  if (!marker && !name) return [];
  // The provider-side full-text term; the matcher below is what actually
  // verifies a hit (`q` is loose on both providers).
  const term = marker || name;
  const matches = marker ? markerMatcher(marker) : attendeeNameMatcher(name);
  const collectAll = !marker;
  const found: SearchedEvent[] = [];
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
        const res = await workspaceProxyForBusiness(businessId, proxyTarget(conn), {
          endpoint,
          method: "GET",
          params: {
            q: term,
            timeMin: nowIso,
            singleEvents: "true",
            orderBy: "startTime",
            // q already narrows server-side to matching events; a generous
            // page keeps a busy calendar's valid booking from falling past
            // it without pagination (Bugbot on PR #577).
            maxResults: "50"
          }
        });
        const items =
          ((res?.data ?? null) as {
            items?: Array<{
              id?: string;
              description?: string;
              start?: { dateTime?: string };
            }>;
          } | null)?.items ?? [];
        // `q` is a loose full-text match, verify the identity actually sits
        // in the event description before mutating anything, mirroring the
        // Microsoft path, so a fuzzy hit can never reschedule/cancel someone
        // else's event (Bugbot on PR #577).
        for (const e of items) {
          if (typeof e.id !== "string" || e.id.length === 0) continue;
          if (!matches(e.description ?? "")) continue;
          const startMs = Date.parse(e.start?.dateTime ?? "");
          found.push({
            eventId: e.id,
            startIso: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null
          });
          if (!collectAll) return found;
        }
      } catch (err) {
        logger.warn("calendar-tools/search: google lookup failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return found;
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
      const res = await workspaceProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint,
        method: "GET",
        params: {
          startDateTime: nowIso,
          endDateTime: endIso,
          // Full body, not just bodyPreview: booked events carry free-form
          // notes BEFORE the Attendee/Phone/Email marker lines, and Graph
          // previews are short, long notes would push the marker out of the
          // preview and make valid appointments unfindable (Bugbot on
          // PR #577). The marker (an E.164 or email) substring-matches even
          // when Graph returns the body HTML-wrapped.
          $select: "id,bodyPreview,body,start",
          $orderby: "start/dateTime",
          // A busy calendar can hold far more than a couple dozen upcoming
          // events in the window; a small page made valid bookings past it
          // unfindable (Bugbot on PR #577). One large page keeps the call
          // single-round-trip, the search is already scoped to 60 days.
          $top: "250"
        }
      });
      const items =
        ((res?.data ?? null) as {
          value?: Array<{
            id?: string;
            bodyPreview?: string;
            body?: { content?: string };
            start?: { dateTime?: string; timeZone?: string };
          }>;
        } | null)?.value ?? [];
      for (const e of items) {
        if (typeof e.id !== "string" || e.id.length === 0) continue;
        if (!matches(`${e.body?.content ?? ""}\n${e.bodyPreview ?? ""}`)) continue;
        const startMs = Date.parse(graphTimeIso(e.start) ?? "");
        found.push({
          eventId: e.id,
          startIso: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null
        });
        if (!collectAll) return found;
      }
    } catch (err) {
      logger.warn("calendar-tools/search: microsoft lookup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return found;
}

/**
 * Outcome of locating the appointment to act on. `ambiguous` is what lets
 * the model ask "which one?" instead of guessing: several upcoming
 * appointments carry the same attendee name and the caller named no time
 * (or a time none of them sit at).
 */
type LocateOutcome =
  | { kind: "found"; event: LocatedEvent }
  | { kind: "ambiguous"; candidates: SearchedEvent[] }
  | { kind: "none" };

/** True when two ISO instants denote the same moment (formatting-agnostic). */
function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * Narrow candidates to the appointment the caller meant. With no target
 * start every candidate stays (the ambiguity contract decides). With one,
 * candidates AT that instant win; if none sits there the full set is kept,
 * so a single candidate still resolves (it is the person's only upcoming
 * appointment, and provider listings do not always carry a start) while a
 * genuinely ambiguous set still asks.
 */
function narrowToTargetStart(
  candidates: SearchedEvent[],
  targetStartIso: string | undefined
): SearchedEvent[] {
  if (!targetStartIso) return candidates;
  const atTarget = candidates.filter((c) => c.startIso && sameInstant(c.startIso, targetStartIso));
  return atTarget.length > 0 ? atTarget : candidates;
}

/** Ledger first, provider search second. */
async function locateUpcomingAppointment(
  businessId: string,
  conn: ResolvedVoiceConnection,
  attendeeKey: string,
  query: SearchQuery,
  targetStartIso?: string
): Promise<LocateOutcome> {
  const claim = await findUpcomingBookingClaim(businessId, attendeeKey);
  // A claim at a DIFFERENT time than the one the caller named is not the
  // appointment they meant: fall through to the search rather than move or
  // delete the wrong booking.
  const claimMatchesTarget =
    !targetStartIso || (claim ? sameInstant(claim.startAt, targetStartIso) : false);
  if (claim && claimMatchesTarget) {
    return {
      kind: "found",
      event: {
        eventId: claim.eventId,
        claimId: claim.id,
        zoomMeetingId: claim.zoomMeetingId,
        startAt: claim.startAt
      }
    };
  }
  const candidates = narrowToTargetStart(
    await searchProviderEvents(businessId, conn, query),
    targetStartIso
  );
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  const searched = candidates[0];
  // The event may still hold a ledger row under a DIFFERENT attendee key
  // (booked by phone, rescheduled by email) carrying the booking's Zoom
  // meeting, capture it NOW, before the callers' by-event ledger cleanup
  // deletes that row, so the meeting still moves/dies with the event.
  const zoomMeetingId = await findZoomMeetingIdByEvent(businessId, searched.eventId);
  return {
    kind: "found",
    event: {
      eventId: searched.eventId,
      claimId: null,
      zoomMeetingId,
      startAt: searched.startIso
    }
  };
}

/**
 * The "which one?" result. Candidate start times ride in `data` so the model
 * can name the options back to the owner, and `message` steers it to ask
 * rather than retry blindly.
 */
function multipleMatchesResult(candidates: SearchedEvent[]): CalendarToolResult {
  return {
    ok: false,
    detail: "multiple_matches",
    data: {
      candidates: candidates.map((c) => ({ startIso: c.startIso }))
    },
    message:
      "Several upcoming appointments match that name. Ask which one they mean, naming the start times in data.candidates, then call again with appointmentStartIso set to the one they pick."
  };
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
      const res = await workspaceProxyForBusiness(businessId, proxyTarget(conn), {
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

/**
 * Ledger resolution for Vagaro, Acuity and CalDAV (their ONLY resolution
 * path, none has a search-by-customer cancel surface): exact attendee key
 * first, then the phone-tolerant fallback, since the booking may have
 * stored a differently formatted phone than the lifecycle call passes
 * (Bugbot on PR #584).
 */
async function findLedgerOnlyClaim(businessId: string, attendeeKey: string, phone: string) {
  const exact = await findUpcomingBookingClaim(businessId, attendeeKey);
  if (exact) return exact;
  return phone ? findUpcomingBookingClaimByPhone(businessId, phone) : null;
}

/**
 * Move the attendee's upcoming appointment to a new time IN PLACE. The
 * provider sends the attendee an UPDATED invitation for the same event,
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

    const phone = (args.attendeePhone ?? fallbackPhone ?? "").trim();
    const marker = phone || (args.attendeeEmail ?? "").trim();
    const attendeeKey = bookingAttendeeKey(phone, args.attendeeEmail, args.attendeeName);

    if (conn.provider === "calendly") {
      // No event mutation on our side: the invitee moves the SAME event
      // through their reschedule link, and Calendly emails the update.
      return createCalendlyRescheduleLink(businessId, conn, {
        phone,
        email: args.attendeeEmail ?? null
      });
    }

    if (
      conn.provider === "vagaro" ||
      conn.provider === "acuity" ||
      conn.provider === "caldav"
    ) {
      const claim = await findLedgerOnlyClaim(businessId, attendeeKey, phone);
      if (!claim) return { ok: false, detail: "booking_not_found" };
      // A switch rather than nested ternaries: this arm gained a third
      // provider, and the next one should be a one-line addition.
      let moved: CalendarToolResult;
      switch (conn.provider) {
        case "vagaro":
          moved = await rescheduleVagaroAppointment(
            businessId,
            claim.eventId,
            args.newStartIso,
            args.newEndIso
          );
          break;
        case "acuity":
          moved = await rescheduleAcuityAppointment(
            businessId,
            claim.eventId,
            args.newStartIso,
            args.newEndIso
          );
          break;
        default:
          moved = await rescheduleCaldavAppointment(
            businessId,
            claim.eventId,
            args.newStartIso,
            args.newEndIso
          );
      }
      if (moved.ok) {
        await rescheduleBookingClaim(
          businessId,
          // The row's own key when the phone-tolerant fallback resolved it,
          // conflict cleanup must target the key the row is stored under.
          claim.attendeeKey ?? attendeeKey,
          claim.id,
          new Date(args.newStartIso).toISOString()
        );
        // Move the booking's Zoom meeting with it (best-effort; only CalDAV
        // bookings carry one on this path, Vagaro bookings are Zoom-free).
        if (claim.zoomMeetingId) {
          await updateZoomMeetingForBooking(businessId, claim.zoomMeetingId, {
            startIso: args.newStartIso,
            endIso: args.newEndIso
          });
        }
        // Move the shared-calendar mirror with it. A mirror left at the old
        // time is worse than none: the team plans around an appointment that
        // is no longer there.
        if (claim.sharedCalendarEventId) {
          await moveSharedCalendarMirror(
            businessId,
            claim.sharedCalendarEventId,
            args.newStartIso,
            args.newEndIso
          );
        }
        // Waitlist (both best-effort by module contract): the attendee's
        // own live entries resolve against the new start FIRST, then the
        // vacated OLD slot is offered to whoever is waiting, with the
        // mover excluded so they are never texted the slot they just gave
        // up (Bugbot Medium on PR #903).
        const attendee = { phones: phone ? [phone] : [], email: args.attendeeEmail ?? null };
        await resolveWaitlistAfterBooking(businessId, attendee, args.newStartIso);
        await offerFreedSlot(businessId, claim.startAt, {}, attendee);
      } else if (moved.detail === "booking_not_found") {
        // The provider event is gone (deleted upstream) but the ledger row
        // survived, drop it so the stale claim can't shadow the slot or
        // resolve future lifecycle calls to a dead event. Its mirror goes
        // with it: the appointment it represents no longer exists, and a
        // surviving mirror is what the team plans around.
        if (claim.sharedCalendarEventId) {
          await removeSharedCalendarMirror(businessId, claim.sharedCalendarEventId);
        }
        await deleteBookingClaim(claim.id);
      }
      return moved;
    }

    const outcome = await locateUpcomingAppointment(
      businessId,
      conn,
      attendeeKey,
      { marker, name: args.attendeeName ?? "" },
      args.appointmentStartIso
    );
    if (outcome.kind === "ambiguous") return multipleMatchesResult(outcome.candidates);
    if (outcome.kind === "none") return { ok: false, detail: "booking_not_found" };
    const located = outcome.event;

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
      const res = await workspaceProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint: `/v1.0/me/events/${encodeURIComponent(located.eventId)}`,
        method: "PATCH",
        data: {
          start: { dateTime: wallClockInZone(startInstant, eventTimezone), timeZone: eventTimezone },
          end: { dateTime: wallClockInZone(endInstant, eventTimezone), timeZone: eventTimezone }
        }
      });
      // The connection resolved moments ago, so a falsy proxy response here
      // is a failed MUTATION, not a missing calendar, reporting
      // calendar_not_connected would steer the model to "you cannot change
      // any appointment" (Bugbot on PR #577).
      if (!res) return { ok: false, detail: "calendar_reschedule_failed" };
    }

    // Keep the slot ledger matching the provider event so a later duplicate
    // check / reschedule / cancel resolves without a provider search. For a
    // provider-search hit (no ledger row under OUR key), first drop any row
    // the event holds under a DIFFERENT attendee key, its old start would
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

    // Move the booking's Zoom meeting with the event (best-effort). Both
    // resolution paths can carry one: a ledger hit reads it off the claim
    // row; a provider-search hit captured it from the event's row under a
    // different key before the cleanup above deleted that row.
    if (located.zoomMeetingId) {
      await updateZoomMeetingForBooking(businessId, located.zoomMeetingId, {
        startIso: args.newStartIso,
        endIso: args.newEndIso
      });
    }

    // Waitlist (best-effort by module contract): the attendee's own live
    // entries resolve against the new start first, then the vacated OLD
    // slot (when the ledger or the search listing carried it) is offered
    // with the mover excluded.
    const waitlistAttendee = {
      phones: phone ? [phone] : [],
      email: args.attendeeEmail ?? null
    };
    await resolveWaitlistAfterBooking(businessId, waitlistAttendee, args.newStartIso);
    if (located.startAt) {
      await offerFreedSlot(businessId, located.startAt, {}, waitlistAttendee);
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

    const phone = (args.attendeePhone ?? fallbackPhone ?? "").trim();
    const marker = phone || (args.attendeeEmail ?? "").trim();
    const attendeeKey = bookingAttendeeKey(phone, args.attendeeEmail, args.attendeeName);

    if (conn.provider === "calendly") {
      // Located + canceled through Calendly's own API (no ledger rows exist
      // for link-completed bookings).
      const calendlyCanceled = await cancelCalendlyAppointment(businessId, conn, {
        phone,
        email: args.attendeeEmail ?? null
      });
      if (calendlyCanceled.ok) {
        // No freed-slot offer here: the locate step never learns the event's
        // start, and the calendar poll's canceled scan observes it anyway.
        // The canceling attendee's own waitlist entries are moot though.
        await cancelWaitlistForAttendee(businessId, {
          phones: phone ? [phone] : [],
          email: args.attendeeEmail ?? null
        });
      }
      return calendlyCanceled;
    }

    if (
      conn.provider === "vagaro" ||
      conn.provider === "acuity" ||
      conn.provider === "caldav"
    ) {
      const claim = await findLedgerOnlyClaim(businessId, attendeeKey, phone);
      if (!claim) return { ok: false, detail: "booking_not_found" };
      let canceled: CalendarToolResult;
      switch (conn.provider) {
        case "vagaro":
          canceled = await cancelVagaroAppointment(businessId, claim.eventId);
          break;
        case "acuity":
          // The ledger's start goes WITH the id: Acuity cancellation cannot
          // be undone, so the core refuses when the appointment it finds
          // does not start when the ledger says it should.
          canceled = await cancelAcuityAppointment(
            businessId,
            claim.eventId,
            new Date(claim.startAt).toISOString()
          );
          break;
        default:
          canceled = await cancelCaldavAppointment(businessId, claim.eventId);
      }
      if (canceled.ok) {
        await deleteBookingClaim(claim.id);
        // Delete the booking's Zoom meeting with it (best-effort; only
        // CalDAV bookings carry one here, Vagaro bookings are Zoom-free).
        if (claim.zoomMeetingId) {
          await deleteZoomMeetingForBooking(businessId, claim.zoomMeetingId);
        }
        // Remove the shared-calendar mirror too. This is the half that makes
        // mirroring safe to ship: a mirror surviving its cancellation shows
        // the team an appointment that is not happening, and they act on it.
        if (claim.sharedCalendarEventId) {
          await removeSharedCalendarMirror(businessId, claim.sharedCalendarEventId);
        }
        // Waitlist (best-effort by module contract): the canceler's own
        // entries are moot and drop FIRST, then the canceled slot is
        // offered to whoever is waiting, with the canceler excluded so a
        // race can never text them the slot they just walked away from
        // (Bugbot Medium on PR #903).
        const attendee = { phones: phone ? [phone] : [], email: args.attendeeEmail ?? null };
        await cancelWaitlistForAttendee(businessId, attendee);
        await offerFreedSlot(businessId, claim.startAt, {}, attendee);
      } else if (canceled.detail === "booking_not_found") {
        // The provider no longer has the appointment (deleted upstream, or
        // the claim's start has drifted from reality). Either way the row is
        // stale: drop it so it cannot shadow future lifecycle calls, and
        // take its mirror with it, matching the reschedule path above. A
        // mirror representing a booking the provider cannot find is showing
        // the team something that does not exist.
        if (claim.sharedCalendarEventId) {
          await removeSharedCalendarMirror(businessId, claim.sharedCalendarEventId);
        }
        await deleteBookingClaim(claim.id);
      }
      return canceled;
    }

    const outcome = await locateUpcomingAppointment(
      businessId,
      conn,
      attendeeKey,
      { marker, name: args.attendeeName ?? "" },
      args.appointmentStartIso
    );
    if (outcome.kind === "ambiguous") return multipleMatchesResult(outcome.candidates);
    if (outcome.kind === "none") return { ok: false, detail: "booking_not_found" };
    const located = outcome.event;

    if (conn.provider === "google") {
      const deleted = await mutateGoogleEvent(businessId, conn, located.eventId, "DELETE");
      if (!deleted) return { ok: false, detail: "calendar_cancel_failed" };
    } else {
      const res = await workspaceProxyForBusiness(businessId, proxyTarget(conn), {
        endpoint: `/v1.0/me/events/${encodeURIComponent(located.eventId)}`,
        method: "DELETE"
      });
      // Same rationale as the reschedule PATCH: the calendar exists, this
      // is a failed mutation, not a disconnected calendar.
      if (!res) return { ok: false, detail: "calendar_cancel_failed" };
    }

    // Ledger cleanup covers BOTH resolution paths: the caller's own claim row
    // (ledger hit) and any row recorded under a different attendee key
    // (provider-search hit), a canceled slot must never survive as a
    // "booked" ledger entry under any key.
    if (located.claimId) {
      await deleteBookingClaim(located.claimId);
    } else {
      await deleteBookingClaimsByEvent(businessId, located.eventId);
    }

    // Delete the booking's Zoom meeting with the event (best-effort).
    if (located.zoomMeetingId) {
      await deleteZoomMeetingForBooking(businessId, located.zoomMeetingId);
    }

    // Waitlist (best-effort by module contract): the canceler's own
    // entries drop first, then the freed slot (when the ledger or the
    // search listing carried it) is offered with the canceler excluded.
    const waitlistAttendee = {
      phones: phone ? [phone] : [],
      email: args.attendeeEmail ?? null
    };
    await cancelWaitlistForAttendee(businessId, waitlistAttendee);
    if (located.startAt) {
      await offerFreedSlot(businessId, located.startAt, {}, waitlistAttendee);
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
