/**
 * Acuity provider cores for the calendar tools.
 *
 * Like Vagaro, Acuity is the merchant's REAL book: `calendar_find_slots`
 * reads live availability and `calendar_book_appointment` creates the
 * appointment. The shape mirrors `@/lib/calendar-tools/vagaro` so
 * handlers.ts and reschedule.ts can treat the two symmetrically, but four
 * things about Acuity's API force real differences:
 *
 *   1. AVAILABILITY IS DATE-SCOPED. There is no "free slots between X and
 *      Y" endpoint, only "which days in this month" and "which times on
 *      this day". `findAcuitySlots` therefore fans out, and the fan-out is
 *      bounded three ways (a month prefilter, a day cap, and an early exit
 *      at MAX_SLOTS) because Acuity's rate limit is per egress IP and shared
 *      across the whole fleet.
 *
 *   2. CREATE REQUIRES AN EMAIL, WHICH VOICE CALLERS OFTEN DO NOT GIVE.
 *      See `acuityBookingEmail`.
 *
 *   3. RESCHEDULE MUST IGNORE THE APPOINTMENT'S OWN SLOT, or moving a
 *      booking by less than its own duration reads as unavailable.
 *
 *   4. CANCEL IS IRREVERSIBLE. `cancelAcuityAppointment` verifies the target
 *      against the booking ledger and refuses rather than guessing.
 *
 * Errors that mean "the stored credentials are wrong" surface as the
 * distinct detail `acuity_auth_failed` so the model can tell the caller the
 * owner needs to reconnect; "that time just went" surfaces as
 * `acuity_slot_taken` with model-facing steering; everything else throws and
 * is mapped by handlers.ts to the usual calendar_lookup_failed /
 * calendar_book_failed.
 */

import {
  getActiveAcuityConnection,
  type AcuityConnectionRow
} from "@/lib/db/acuity-connections";
import {
  acuityDateTime,
  acuityLocalDate,
  AcuityApiError,
  cancelAcuityAppointmentById,
  createAcuityAppointment,
  getAcuityAppointment,
  listAcuityAppointments,
  listAcuityAppointmentTypes,
  listAcuityAvailableDates,
  listAcuityAvailableTimes,
  rescheduleAcuityAppointmentTime,
  type AcuityAppointmentType
} from "@/lib/acuity/client";
import type { CalendarToolResult } from "@/lib/calendar-tools/handlers";

/** Match the other providers: offer at most 3 candidate slots. */
const MAX_SLOTS = 3;

/**
 * Days probed per availability search. The tools' default window is 7 days
 * (DEFAULT_SEARCH_WINDOW_MS), so this is the natural ceiling; it exists to
 * bound the fan-out, not to narrow what the model asked for.
 */
export const ACUITY_MAX_AVAILABILITY_DAYS = 7;

/**
 * Worst case per availability search, given the cap above: 1 catalog read
 * (usually cached) + at most 2 month prefilters + at most 7 day reads. The
 * early exit at MAX_SLOTS means the common case is 1 to 3. A test asserts
 * this ceiling, which is the real guarantee, rather than a runtime counter
 * that the day cap already makes unreachable.
 */
export const ACUITY_MAX_AVAILABILITY_CALLS = 1 + 2 + ACUITY_MAX_AVAILABILITY_DAYS;

/**
 * Above this many candidate days, spend one request per month on
 * `/availability/dates` first so closed and fully-booked days cost zero
 * `/availability/times` calls. Below it the prefilter would cost more
 * requests than it saves.
 */
export const ACUITY_DATES_PREFILTER_THRESHOLD = 2;

export type AcuityFindSlotsArgs = {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  purpose?: string;
  /** Explicit Acuity appointment type (beats duration matching). */
  serviceId?: string;
  /** Already resolved (model choice → business tz → UTC) by the caller. */
  timezone: string;
  /**
   * Treat this appointment's own slot as free. Set when computing
   * availability for a RESCHEDULE of that appointment.
   */
  ignoreAppointmentId?: string;
};

export type AcuityBookArgs = {
  startIso: string;
  endIso: string;
  summary: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  serviceId?: string;
  /**
   * Already resolved (model choice → business tz → UTC) by the caller.
   *
   * This does NOT change which instant gets booked: `startIso` is absolute
   * and `acuityDateTime` renders it with an explicit offset, so any correct
   * zone names the same moment. It is the CUSTOMER-facing zone Acuity stamps
   * on the appointment and its notifications, which is why the caller's
   * resolved zone beats the merchant's calendar default.
   */
  timezone?: string;
};

export type ResolvedAcuityType = {
  id: string;
  name: string | null;
  durationMinutes: number | null;
};

/**
 * Split a display name into the first/last pair Acuity requires.
 *
 * A single-token name gets `"-"` rather than an empty last name, which
 * Acuity rejects outright. Everything after the first token is the last
 * name, so "Ana de la Cruz" keeps its full surname instead of losing words.
 */
export function splitAcuityName(attendeeName: string): {
  firstName: string;
  lastName: string;
} {
  const parts = attendeeName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Customer", lastName: "-" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "-" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Acuity's `POST /appointments` requires an email, but the platform's
 * `attendeeEmail` is optional and phone callers routinely have none. Rather
 * than refuse those bookings (Vagaro and CalDAV take them happily), mint a
 * synthetic address.
 *
 * The domain is RFC 2606's reserved `example.com`, never a domain we or the
 * merchant control, so the address cannot deliver anywhere even by accident.
 * Callers pair it with `noEmail=true` so Acuity never tries.
 */
export function acuityBookingEmail(
  attendeeEmail: string | null | undefined,
  phone: string | null | undefined
): string {
  const given = attendeeEmail?.trim();
  if (given) return given;
  const digits = (phone ?? "").replace(/\D/g, "");
  return `no-reply+${digits || "unknown"}@example.com`;
}

/**
 * Which appointment type the tools operate on. Order: explicit arg → owner
 * default → closest-duration active service.
 *
 * Unlike Vagaro's equivalent, a pinned id is still looked up in the catalog:
 * the type's `duration` is how we compute a slot's end, so returning it
 * unresolved would leave every slot end-less. A pinned id that no longer
 * exists (the owner archived it) degrades to an unresolved duration rather
 * than failing the whole tool call.
 */
export async function resolveAcuityAppointmentType(
  conn: AcuityConnectionRow,
  explicitTypeId: string | undefined,
  durationMinutes: number
): Promise<ResolvedAcuityType | "no_types"> {
  const types = await listAcuityAppointmentTypes(conn);
  const pinnedId = explicitTypeId?.trim() || conn.default_appointment_type_id;
  if (pinnedId) {
    const found = types.find((t) => t.id === pinnedId);
    return found
      ? { id: found.id, name: found.name, durationMinutes: found.durationMinutes }
      : { id: pinnedId, name: null, durationMinutes: null };
  }

  const bookable = types.filter((t) => isBookableAcuityType(t, conn.default_calendar_id));
  if (bookable.length === 0) return "no_types";
  let best = bookable[0];
  for (const candidate of bookable.slice(1)) {
    const bestGap = Math.abs((best.durationMinutes ?? durationMinutes) - durationMinutes);
    const gap = Math.abs((candidate.durationMinutes ?? durationMinutes) - durationMinutes);
    if (gap < bestGap) best = candidate;
  }
  return { id: best.id, name: best.name, durationMinutes: best.durationMinutes };
}

/**
 * Only one-on-one services are bookable here. Acuity's `type` field is an
 * exact discriminator (`"service" | "class" | "series"`), and classes must go
 * through `/availability/classes`, which v1 does not implement, matching one
 * by duration would produce confusing failures at booking time.
 */
function isBookableAcuityType(type: AcuityAppointmentType, defaultCalendarId: string | null): boolean {
  if (!type.active) return false;
  if (type.type !== "service") return false;
  if (defaultCalendarId && type.calendarIds.length > 0) {
    return type.calendarIds.includes(defaultCalendarId);
  }
  return true;
}

/** The distinct `YYYY-MM` months a list of local dates spans, in order. */
function monthsOf(localDates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of localDates) {
    const month = d.slice(0, 7);
    if (seen.has(month)) continue;
    seen.add(month);
    out.push(month);
  }
  return out;
}

/** The calendar date after `iso` (a `YYYY-MM-DD` string). */
function nextIsoDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The local calendar dates the window covers, in the resolved timezone,
 * capped at `maxDays`.
 *
 * Walks the DATE STRINGS from the window's first local day to its last
 * rather than stepping the instant by 24h: a UTC-day walk drifts across DST
 * boundaries and can step over the final local day of a short window, so it
 * needed dedupe and a tail patch to be correct. Converting the two endpoints
 * once and counting days between them has neither problem.
 */
export function acuityWindowDates(
  startMs: number,
  endMs: number,
  timezone: string,
  maxDays: number
): string[] {
  const last = acuityLocalDate(new Date(endMs - 1), timezone);
  const out: string[] = [];
  let cursor = acuityLocalDate(new Date(startMs), timezone);
  while (out.length < maxDays) {
    out.push(cursor);
    if (cursor >= last) break;
    cursor = nextIsoDate(cursor);
  }
  return out;
}

/** `calendar_find_slots` core for Acuity connections. */
export async function findAcuitySlots(
  businessId: string,
  args: AcuityFindSlotsArgs
): Promise<CalendarToolResult> {
  const conn = await getActiveAcuityConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    // Acuity won't offer past slots; clamp the window start to now.
    const startMs = Math.max(args.windowStart.getTime(), Date.now());
    const endMs = args.windowEnd.getTime();
    if (endMs <= startMs) return { ok: false, detail: "invalid_window" };

    const type = await resolveAcuityAppointmentType(conn, args.serviceId, args.durationMinutes);
    if (type === "no_types") return { ok: false, detail: "acuity_no_types" };

    const timezone = args.timezone;
    let candidateDates = acuityWindowDates(
      startMs,
      endMs,
      timezone,
      ACUITY_MAX_AVAILABILITY_DAYS
    );
    // Month prefilter: one request per month buys us the set of days that
    // have ANY availability, so closed days cost nothing further.
    if (candidateDates.length > ACUITY_DATES_PREFILTER_THRESHOLD) {
      const openDates = new Set<string>();
      for (const month of monthsOf(candidateDates)) {
        const dates = await listAcuityAvailableDates(conn, {
          month,
          appointmentTypeId: type.id,
          calendarId: conn.default_calendar_id,
          timezone
        });
        for (const d of dates) openDates.add(d);
      }
      candidateDates = candidateDates.filter((d) => openDates.has(d));
    }

    const durationMinutes = type.durationMinutes ?? args.durationMinutes;
    const slots: Array<{ startIso: string; endIso: string }> = [];

    for (const date of candidateDates) {
      // Early exit is what keeps the common case ("tomorrow afternoon") at a
      // single request: the coworker only ever offers three slots.
      if (slots.length >= MAX_SLOTS) break;
      const times = await listAcuityAvailableTimes(conn, {
        date,
        appointmentTypeId: type.id,
        calendarId: conn.default_calendar_id,
        timezone,
        ignoreAppointmentId: args.ignoreAppointmentId ?? null
      });
      for (const startIso of times) {
        if (slots.length >= MAX_SLOTS) break;
        // A day's listing spans the whole local day; keep only what falls
        // inside the window the model actually asked about.
        const ms = Date.parse(startIso);
        if (ms < startMs || ms >= endMs) continue;
        slots.push({
          startIso,
          endIso: new Date(ms + durationMinutes * 60_000).toISOString()
        });
      }
    }

    return {
      ok: true,
      data: {
        slots,
        timezone,
        purpose: args.purpose ?? null,
        durationMinutes,
        provider: "acuity",
        serviceId: type.id,
        serviceName: type.name
      }
    };
  } catch (err) {
    return rethrowUnlessKnown(err);
  }
}

/**
 * `calendar_book_appointment` core for Acuity connections, creates a real
 * appointment on the merchant's book.
 *
 * Books in ADMIN mode when a calendar can be pinned, which skips Acuity's own
 * availability validation (we just read it), allows notes, and makes the
 * email optional. Without a pinnable calendar admin mode is not available at
 * all, so the create runs in client mode and lets Acuity validate, which is
 * the safer of the two failure modes.
 *
 * @param fallbackPhone surface-provided attendee phone (the voice bridge
 *   passes the caller's number) when the model omits one.
 */
export async function bookAcuityAppointment(
  businessId: string,
  args: AcuityBookArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  const conn = await getActiveAcuityConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    const requestedMinutes = Math.max(
      1,
      Math.round((new Date(args.endIso).getTime() - new Date(args.startIso).getTime()) / 60_000)
    );
    const type = await resolveAcuityAppointmentType(conn, args.serviceId, requestedMinutes);
    if (type === "no_types") return { ok: false, detail: "acuity_no_types" };

    const timezone = args.timezone ?? conn.default_calendar_timezone ?? "UTC";
    const phone = args.attendeePhone ?? fallbackPhone ?? null;
    const { firstName, lastName } = splitAcuityName(args.attendeeName);
    const notes = [args.summary, args.notes ?? ""]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    const calendarId = conn.default_calendar_id;
    const created = await createAcuityAppointment(conn, {
      datetime: acuityDateTime(args.startIso, timezone),
      appointmentTypeId: type.id,
      firstName,
      lastName,
      email: acuityBookingEmail(args.attendeeEmail, phone),
      phone,
      timezone,
      calendarId,
      notes,
      // admin requires a calendarID; without one Acuity rejects the call.
      admin: Boolean(calendarId),
      noEmail: conn.suppress_provider_emails
    });

    return {
      ok: true,
      data: {
        eventId: created?.id ?? null,
        htmlLink: null,
        provider: "acuity",
        calendar: "acuity",
        serviceId: type.id,
        serviceName: type.name,
        // Acuity emails the customer itself unless the owner suppressed it;
        // be explicit so the model never promises a confirmation we withheld.
        inviteEmail: conn.suppress_provider_emails ? null : (args.attendeeEmail ?? null)
      }
    };
  } catch (err) {
    return rethrowUnlessKnown(err);
  }
}

/**
 * `calendar_reschedule_appointment` core for Acuity connections: moves the
 * located appointment IN PLACE. The appointment id comes from the caller
 * (resolved via the booking ledger); there is no Acuity-side search, so a
 * ledger-less booking surfaces booking_not_found upstream.
 */
export async function rescheduleAcuityAppointment(
  businessId: string,
  appointmentId: string,
  newStartIso: string,
  newEndIso: string
): Promise<CalendarToolResult> {
  const conn = await getActiveAcuityConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    const existing = await getAcuityAppointment(conn, appointmentId);
    // Gone or already canceled: the ledger row points at something that no
    // longer exists, and handlers upstream drop the stale claim on exactly
    // this detail.
    if (!existing || existing.canceled) return { ok: false, detail: "booking_not_found" };

    const timezone = existing.timezone ?? conn.default_calendar_timezone ?? "UTC";
    const targetMs = new Date(newStartIso).getTime();

    // Verify the new time against availability that IGNORES this
    // appointment. Without the ignore, its own slot reads as busy and any
    // move smaller than its duration is rejected as unavailable.
    //
    // We can only run that check with an appointment type id. When the
    // payload has none, DO NOT fall through to an admin reschedule: admin
    // mode skips Acuity's own validation, so an unverifiable move plus a
    // waived validation is how a double-booking gets written. Reschedule in
    // client mode instead and let Acuity be the one to say no.
    const verifiable = Boolean(existing.appointmentTypeId);
    if (verifiable) {
      const times = await listAcuityAvailableTimes(conn, {
        date: acuityLocalDate(new Date(targetMs), timezone),
        appointmentTypeId: existing.appointmentTypeId as string,
        calendarId: existing.calendarId,
        timezone,
        ignoreAppointmentId: appointmentId
      });
      if (!times.some((t) => Date.parse(t) === targetMs)) {
        return {
          ok: false,
          detail: "acuity_slot_taken",
          message:
            "That time is not open on the Acuity calendar. Offer the customer another time from calendar_find_slots."
        };
      }
    }

    const moved = await rescheduleAcuityAppointmentTime(conn, appointmentId, {
      datetime: acuityDateTime(newStartIso, timezone),
      timezone,
      admin: verifiable,
      noEmail: conn.suppress_provider_emails
    });
    // The same confirmed-event rule the booking paths use: only a response
    // that actually carries the moved appointment counts as moved. A 2xx with
    // no parseable body is anomalous for this endpoint, and reporting success
    // on it would let the caller shift the ledger claim to a time Acuity may
    // never have written.
    if (!moved) return { ok: false, detail: "calendar_reschedule_failed" };

    return {
      ok: true,
      data: {
        eventId: appointmentId,
        provider: "acuity",
        startIso: new Date(newStartIso).toISOString(),
        endIso: new Date(newEndIso).toISOString(),
        rescheduled: true
      }
    };
  } catch (err) {
    return rethrowUnlessKnown(err);
  }
}

/**
 * `calendar_cancel_appointment` core for Acuity connections.
 *
 * Acuity cancellation CANNOT BE UNDONE, so this reads the appointment first
 * and uses it three ways: an already-canceled appointment reports success
 * (a webhook retry or a double tool call must not look like a failure), a
 * start time that disagrees with the ledger claim means the row is stale and
 * we refuse WITHOUT cancelling anything, and only a verified match reaches
 * the cancel call.
 *
 * @param expectedStartIso the resolving ledger claim's start, when the
 *   caller has one. Omitted only by callers that already hold the
 *   appointment id from Acuity itself.
 */
export async function cancelAcuityAppointment(
  businessId: string,
  appointmentId: string,
  expectedStartIso?: string | null
): Promise<CalendarToolResult> {
  const conn = await getActiveAcuityConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    const existing = await getAcuityAppointment(conn, appointmentId);
    if (!existing) return { ok: false, detail: "booking_not_found" };
    if (existing.canceled) {
      return {
        ok: true,
        data: {
          eventId: appointmentId,
          provider: "acuity",
          canceled: true,
          alreadyCanceled: true
        }
      };
    }
    if (expectedStartIso) {
      const expectedMs = new Date(expectedStartIso).getTime();
      if (Date.parse(existing.startIso) !== expectedMs) {
        // The ledger row has drifted from the real appointment. Cancelling
        // whatever it now points at is unrecoverable, so refuse.
        return { ok: false, detail: "booking_not_found" };
      }
    }

    await cancelAcuityAppointmentById(conn, appointmentId, {
      noEmail: conn.suppress_provider_emails
    });
    return {
      ok: true,
      data: { eventId: appointmentId, provider: "acuity", canceled: true }
    };
  } catch (err) {
    return rethrowUnlessKnown(err);
  }
}

/**
 * Map the two Acuity failures that carry meaning for the model; everything
 * else is a transport problem handlers.ts already knows how to describe.
 */
function rethrowUnlessKnown(err: unknown): CalendarToolResult {
  if (err instanceof AcuityApiError) {
    if (err.code === "auth_failed") return { ok: false, detail: "acuity_auth_failed" };
    if (err.code === "slot_unavailable") {
      return {
        ok: false,
        detail: "acuity_slot_taken",
        message:
          "Acuity refused that time. Offer the customer another time from calendar_find_slots."
      };
    }
  }
  throw err;
}

/** How far ahead an Acuity booking may start and still count as upcoming. */
const ATTENDEE_HORIZON_DAYS = 90;

/**
 * Attendee-lookup adapter: one bounded upcoming-appointments listing,
 * narrowed server-side by the attendee's email or phone where we have one.
 * Throws on transport trouble, per the attendee-bookings failure contract.
 */
export async function listAcuityUpcomingForAttendee(
  businessId: string,
  ids: { phones: string[]; email: string | null },
  deps: {
    getConnection?: typeof getActiveAcuityConnection;
    listAppointments?: typeof listAcuityAppointments;
  } = {}
): Promise<
  | {
      ok: true;
      bookings: Array<{
        eventId: string | null;
        startIso: string;
        name: string | null;
        customerEmail: string | null;
        customerPhone: string | null;
      }>;
    }
  | { ok: false; reason: "not_connected" }
> {
  const getConnection = deps.getConnection ?? getActiveAcuityConnection;
  const listAppointments = deps.listAppointments ?? listAcuityAppointments;
  const conn = await getConnection(businessId);
  if (!conn) return { ok: false, reason: "not_connected" };

  // No identifiers means no server-side filter, and an unfiltered listing is
  // the merchant's ENTIRE upcoming book. Handing that to the duplicate guard
  // would attribute every one of those appointments to this caller and refuse
  // the booking with attendee_already_booked. An empty list is the honest
  // answer: the module's contract is that empty means "no duplicate visible",
  // never "proven none".
  if (!ids.email && !ids.phones[0]) return { ok: true, bookings: [] };

  const nowMs = Date.now();
  const items = await listAppointments(conn, {
    minDate: acuityLocalDate(new Date(nowMs), conn.default_calendar_timezone ?? "UTC"),
    maxDate: acuityLocalDate(
      new Date(nowMs + ATTENDEE_HORIZON_DAYS * 86_400_000),
      conn.default_calendar_timezone ?? "UTC"
    ),
    ...(ids.email ? { email: ids.email } : {}),
    ...(!ids.email && ids.phones[0] ? { phone: ids.phones[0] } : {})
  });

  const bookings = items
    .filter((i) => !i.canceled && Date.parse(i.startIso) > nowMs)
    .sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso))
    .map((i) => ({
      eventId: i.id || null,
      startIso: i.startIso,
      name: i.appointmentTypeName ?? null,
      // Carried so the caller can re-verify identity against the attendee.
      // Acuity's own filters are the first line, not the only one.
      customerEmail: i.customerEmail,
      customerPhone: i.customerPhone
    }));
  return { ok: true, bookings };
}
