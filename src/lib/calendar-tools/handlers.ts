import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { ensureSharedCalendar, getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import { createCalendlyBookingLink, findCalendlySlots } from "@/lib/calendar-tools/calendly";
import { bookVagaroAppointment, findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { bookCaldavAppointment, getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  confirmBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { logger } from "@/lib/logger";

/**
 * Channel-agnostic cores for the calendar tools (`calendar_find_slots`,
 * `calendar_book_appointment`), shared by every surface that exposes them:
 *   - voice  → /api/voice/tools/calendar/* (bridge adapters)
 *   - sms + dashboard → /api/rowboat/tool-call (Rowboat project webhook)
 *
 * Both operate on the FIRST connected calendar (Google FreeBusy / Microsoft
 * Graph getSchedule + event create via the Nango proxy). When no calendar is
 * connected we return `calendar_not_connected` so the model can gracefully
 * offer an alternative instead of pretending it booked something.
 *
 * Bookings land on the dedicated shared "NewCoworker" calendar (created on
 * first booking; see shared-calendar.ts) so the whole team can see them,
 * falling back to the owner's primary calendar if creation fails. Slot
 * search checks busy across BOTH calendars, so owner personal events still
 * prevent double-booking.
 *
 * Calendly connections take a different path (calendly.ts): slot search uses
 * the event type's available times, and "booking" returns a single-use
 * scheduling link (detail `booking_link_created`) because Calendly cannot
 * create bookings on the invitee's behalf. No shared calendar either way.
 *
 * Vagaro connections (vagaro.ts) support REAL booking: availability search +
 * appointment creation on the merchant's book via the direct Vagaro API
 * (per-tenant credentials in vagaro_connections — no Nango involved).
 */

export type CalendarToolResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
};

const DEFAULT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type FindSlotsArgs = {
  purpose?: string;
  earliest?: string;
  latest?: string;
  durationMinutes: number;
  timezone?: string;
  /** Vagaro only: explicit service to search (defaults to the owner's pick). */
  serviceId?: string;
};

export type BookAppointmentArgs = {
  startIso: string;
  endIso: string;
  summary: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  timezone?: string;
  /** Vagaro only: explicit service to book (defaults to the owner's pick). */
  serviceId?: string;
};

type Slot = { startIso: string; endIso: string };

/** True when Intl accepts the string as an IANA timezone. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Timezone the event/slot payloads should use: the model's explicit choice
 * first, then the business timezone, then UTC. Each candidate is validated
 * against Intl (models occasionally send abbreviations like "EDT" that are
 * not IANA zones) so downstream wall-clock conversion can never throw on a
 * bad zone. Looked up per call (single indexed read) and never fatal — a
 * lookup error degrades to UTC, exactly the pre-timezone behavior.
 */
async function resolveToolTimezone(
  businessId: string,
  explicit: string | undefined
): Promise<string> {
  const wanted = explicit?.trim() ?? "";
  if (wanted.length > 0 && isValidTimeZone(wanted)) return wanted;
  try {
    const biz = (await getBusinessTimezone(businessId)) ?? "UTC";
    return isValidTimeZone(biz) ? biz : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * "YYYY-MM-DDTHH:mm:ss" wall-clock time of an instant in a timezone — the
 * format Microsoft Graph's dateTimeTimeZone expects (naive local time plus
 * a separate timeZone field). The caller guarantees a valid IANA zone via
 * resolveToolTimezone.
 */
export function wallClockInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(instant);
  /* c8 ignore next -- the "00" arm is unreachable: Intl always emits every requested part */
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

type FreeBusyBody = {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
};

function parseOptionalDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d;
}

const QUARTER_MS = 15 * 60_000;

/** Minute-of-hour (0-59) of an instant in a timezone; UTC on a bad zone. */
function minuteInZone(instant: Date, timeZone: string): number {
  try {
    const minute = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" })
      .formatToParts(instant)
      .find((p) => p.type === "minute")?.value;
    /* c8 ignore next -- Intl always yields a minute part for this format */
    return minute ? Number(minute) : instant.getUTCMinutes();
  } catch {
    return instant.getUTCMinutes();
  }
}

/**
 * First presentable start inside a free gap, or null when nothing fits.
 *
 * Offered times must land on quarter-hour boundaries, preferring :00/:30
 * (in the requester's timezone) over :15/:45 — a lead offered "5:19 PM"
 * reads it as a glitch, not availability. Every UTC offset in use is a
 * multiple of 15 minutes, so UTC quarter boundaries ARE local quarter
 * boundaries everywhere; only the :00/:30 classification needs the zone
 * (e.g. Kathmandu's +05:45 maps UTC :15 to local :00).
 *
 * Exactly one of the first two quarter boundaries after the gap opens is a
 * :00/:30 — take it when the appointment still fits (at most 15 minutes
 * later than the alternative), otherwise the earliest quarter that fits.
 * If neither of the first two fits, no later start can either.
 */
function alignedGapStart(
  gapStart: Date,
  gapEnd: Date,
  durationMs: number,
  timeZone: string
): Date | null {
  const first = new Date(Math.ceil(gapStart.getTime() / QUARTER_MS) * QUARTER_MS);
  const second = new Date(first.getTime() + QUARTER_MS);
  const fits = (s: Date) => s.getTime() + durationMs <= gapEnd.getTime();
  const onHourOrHalf = (s: Date) => {
    const m = minuteInZone(s, timeZone);
    return m === 0 || m === 30;
  };
  for (const candidate of [first, second]) {
    if (onHourOrHalf(candidate) && fits(candidate)) return candidate;
  }
  // No :00/:30 fits — fall back to the earliest quarter boundary. Only
  // `first` needs checking: `second` is later, so it can never fit when
  // `first` doesn't.
  return fits(first) ? first : null;
}

export function computeFreeSlots(
  windowStart: Date,
  windowEnd: Date,
  busy: Array<{ start: Date; end: Date }>,
  durationMs: number,
  maxSlots = 3,
  timeZone = "UTC"
): Slot[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const slots: Slot[] = [];
  const offerFromGap = (gapStart: Date, gapEnd: Date) => {
    if (slots.length >= maxSlots) return;
    const start = alignedGapStart(gapStart, gapEnd, durationMs, timeZone);
    if (start) {
      slots.push({
        startIso: start.toISOString(),
        endIso: new Date(start.getTime() + durationMs).toISOString()
      });
    }
  };
  let cursor = windowStart;
  for (const block of sorted) {
    if (block.start.getTime() >= windowEnd.getTime()) break;
    if (block.end.getTime() <= cursor.getTime()) continue;
    if (block.start.getTime() > cursor.getTime()) {
      offerFromGap(cursor, block.start);
    }
    // Past the `continue` guard above, block.end > cursor always holds.
    cursor = block.end;
  }
  if (cursor.getTime() < windowEnd.getTime()) {
    offerFromGap(cursor, windowEnd);
  }
  return slots;
}

export async function findCalendarSlots(
  businessId: string,
  args: FindSlotsArgs
): Promise<CalendarToolResult> {
  const now = new Date();
  const windowStart = parseOptionalDate(args.earliest, now);
  const windowEnd = parseOptionalDate(
    args.latest,
    new Date(windowStart.getTime() + DEFAULT_SEARCH_WINDOW_MS)
  );
  const durationMs = args.durationMinutes * 60_000;

  if (windowEnd.getTime() <= windowStart.getTime()) {
    return { ok: false, detail: "invalid_window" };
  }

  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) {
      return { ok: false, detail: "calendar_not_connected" };
    }

    if (conn.provider === "vagaro") {
      const timezone = await resolveToolTimezone(businessId, args.timezone);
      return findVagaroSlots(businessId, {
        windowStart,
        windowEnd,
        durationMinutes: args.durationMinutes,
        purpose: args.purpose,
        serviceId: args.serviceId,
        timezone
      });
    }

    if (conn.provider === "calendly") {
      const timezone = await resolveToolTimezone(businessId, args.timezone);
      return findCalendlySlots(businessId, conn, {
        windowStart,
        windowEnd,
        durationMinutes: args.durationMinutes,
        purpose: args.purpose,
        timezone
      });
    }

    let busy: Array<{ start: Date; end: Date }> = [];

    if (conn.provider === "caldav") {
      // Direct CalDAV: one REPORT against the connected event calendar; the
      // shared slot walk below aligns candidates like every other provider.
      const caldavBusy = await getCaldavBusyBlocks(businessId, windowStart, windowEnd);
      if (!caldavBusy.ok) return caldavBusy.result;
      busy = caldavBusy.busy;
      const timezone = await resolveToolTimezone(businessId, args.timezone);
      const slots = computeFreeSlots(windowStart, windowEnd, busy, durationMs, 3, timezone);
      return {
        ok: true,
        data: {
          slots,
          timezone,
          purpose: args.purpose ?? null,
          durationMinutes: args.durationMinutes
        }
      };
    }

    // Read-only: never creates the shared calendar from the search path.
    const shared = await getSharedCalendar(businessId);

    if (conn.provider === "google") {
      const items = [{ id: "primary" }];
      if (shared) items.push({ id: shared.calendarId });
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/calendar/v3/freeBusy",
          method: "POST",
          data: {
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            items
          }
        }
      );
      if (!res) return { ok: false, detail: "calendar_not_connected" };
      const data = res.data as FreeBusyBody;
      const blocks = Object.values(data?.calendars ?? {}).flatMap((c) => c.busy ?? []);
      busy = blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    } else {
      // Microsoft Graph getSchedule: POST /me/calendar/getSchedule.
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/v1.0/me/calendar/getSchedule",
          method: "POST",
          data: {
            startTime: { dateTime: windowStart.toISOString(), timeZone: "UTC" },
            endTime: { dateTime: windowEnd.toISOString(), timeZone: "UTC" },
            availabilityViewInterval: args.durationMinutes,
            schedules: ["me"]
          }
        }
      );
      if (!res) return { ok: false, detail: "calendar_not_connected" };
      type GraphBusy = {
        value?: Array<{
          scheduleItems?: Array<{ start?: { dateTime: string }; end?: { dateTime: string } }>;
        }>;
      };
      const data = res.data as GraphBusy;
      const items = data?.value?.[0]?.scheduleItems ?? [];
      busy = items
        .filter((i) => i.start?.dateTime && i.end?.dateTime)
        .map((i) => ({ start: new Date(i.start!.dateTime), end: new Date(i.end!.dateTime) }));

      // getSchedule only covers the default calendar; pull the shared
      // NewCoworker calendar's events separately and merge them in.
      if (shared) {
        const viewRes = await nangoProxyForBusiness(
          businessId,
          { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
          {
            endpoint: `/v1.0/me/calendars/${encodeURIComponent(shared.calendarId)}/calendarView`,
            method: "GET",
            params: {
              startDateTime: windowStart.toISOString(),
              endDateTime: windowEnd.toISOString()
            }
          }
        );
        type GraphView = {
          value?: Array<{ start?: { dateTime: string }; end?: { dateTime: string } }>;
        };
        const viewItems = ((viewRes?.data ?? null) as GraphView | null)?.value ?? [];
        busy = busy.concat(
          viewItems
            .filter((i) => i.start?.dateTime && i.end?.dateTime)
            .map((i) => ({ start: new Date(i.start!.dateTime), end: new Date(i.end!.dateTime) }))
        );
      }
    }

    // Resolved BEFORE the slot walk: quarter-hour candidates prefer :00/:30
    // in the requester's local clock, and the echo lets the model present
    // the ISO slots in business-local terms instead of raw UTC.
    const timezone = await resolveToolTimezone(businessId, args.timezone);
    const slots = computeFreeSlots(windowStart, windowEnd, busy, durationMs, 3, timezone);
    return {
      ok: true,
      data: {
        slots,
        timezone,
        purpose: args.purpose ?? null,
        durationMinutes: args.durationMinutes
      }
    };
  } catch (err) {
    logger.warn("calendar-tools/find-slots failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "calendar_lookup_failed" };
  }
}

/**
 * @param fallbackPhone surface-provided attendee phone when the model omits
 *   one (the voice bridge passes the caller's number; webhook surfaces have
 *   no caller context and pass nothing).
 */
/**
 * Stored contact display name for the attendee phone (alias-aware). Best
 * effort: null on no contact, no name, or any lookup failure — the booking
 * proceeds with the model-supplied name.
 */
async function storedAttendeeName(businessId: string, phone: string): Promise<string | null> {
  try {
    const row = await getCustomerMemory(businessId, phone);
    const name = row?.display_name?.trim();
    return name && name.length > 0 ? name : null;
  } catch (err) {
    logger.warn("calendar-tools/book: stored-name lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function bookCalendarAppointment(
  businessId: string,
  rawArgs: BookAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  if (new Date(rawArgs.endIso).getTime() <= new Date(rawArgs.startIso).getTime()) {
    return { ok: false, detail: "invalid_window" };
  }

  // Preferred-name rule (Truly Issue 6): once a contact exists, the stored
  // display name wins over whatever name the model carried in from a lead
  // form or the conversation — invites stop flip-flopping between "Juhu"
  // and "Muhammad Fahad Juhu" for the same person.
  const attendeePhone = (rawArgs.attendeePhone ?? fallbackPhone ?? "").trim();
  const preferredName = attendeePhone ? await storedAttendeeName(businessId, attendeePhone) : null;
  const args: BookAppointmentArgs = preferredName
    ? { ...rawArgs, attendeeName: preferredName }
    : rawArgs;

  // Idempotency guard (2026-07-13 incident): a worker-retried model turn
  // re-runs its tool calls, and provider create APIs are not idempotent —
  // one customer confirmation produced FOUR identical Outlook events. Claim
  // the (business, attendee, start) slot before creating; a repeat attempt
  // inside the window returns the recorded event instead of booking again.
  // Fail-open: a null claim (ledger unavailable) books without dedupe.
  // Calendly is naturally exempt — its link-mode result never confirms an
  // eventId, so its claims are always released.
  const claim = await claimBookingDedupe(
    businessId,
    bookingAttendeeKey(args.attendeePhone ?? fallbackPhone, args.attendeeEmail, args.attendeeName),
    new Date(args.startIso).toISOString()
  );
  if (claim?.kind === "duplicate") {
    return {
      ok: true,
      detail: "already_booked",
      data: { eventId: claim.eventId, deduplicated: true }
    };
  }
  if (claim?.kind === "in_flight") {
    // Another attempt is booking this exact slot right now. Refuse without
    // touching the provider; the in-flight attempt confirms (or its claim
    // expires and a later retry books cleanly).
    return { ok: false, detail: "booking_in_progress" };
  }

  const result = await bookOnProvider(businessId, args, fallbackPhone);

  if (claim?.kind === "claimed") {
    const bookedEventId = (result.data as { eventId?: unknown } | undefined)?.eventId;
    if (result.ok && typeof bookedEventId === "string" && bookedEventId.length > 0) {
      await confirmBookingDedupe(claim.id, bookedEventId);
    } else {
      await releaseBookingDedupe(claim.id);
    }
  }
  return result;
}

async function bookOnProvider(
  businessId: string,
  args: BookAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) {
      return { ok: false, detail: "calendar_not_connected" };
    }

    if (conn.provider === "vagaro") {
      // Real booking on the merchant's Vagaro book (direct API, no Nango).
      const vagaroResult = await bookVagaroAppointment(businessId, args, fallbackPhone);
      // Same confirmed-event rule as the Google/Microsoft paths: only a
      // response carrying an appointment id counts as booked for goals.
      const vagaroEventId = (vagaroResult.data as { eventId?: unknown } | undefined)?.eventId;
      if (vagaroResult.ok && vagaroEventId) {
        await fireGoalEvent(businessId, args.attendeePhone ?? fallbackPhone, {
          kind: "appointment_booked"
        });
      }
      return vagaroResult;
    }

    if (conn.provider === "calendly") {
      // Calendly cannot create the booking — hand back a single-use link.
      return createCalendlyBookingLink(businessId, conn, {
        startIso: args.startIso,
        endIso: args.endIso
      });
    }

    if (conn.provider === "caldav") {
      // Real booking on the owner's CalDAV calendar (direct, no Nango).
      const caldavPhone = args.attendeePhone ?? fallbackPhone ?? "";
      const caldavDescription = [
        args.notes ?? "",
        `Attendee: ${args.attendeeName}`,
        caldavPhone ? `Phone: ${caldavPhone}` : "",
        args.attendeeEmail ? `Email: ${args.attendeeEmail}` : ""
      ]
        .filter((line) => line && line.trim().length > 0)
        .join("\n");
      const caldavResult = await bookCaldavAppointment(businessId, {
        startIso: args.startIso,
        endIso: args.endIso,
        summary: args.summary,
        description: caldavDescription
      });
      // Same confirmed-event rule as the other real-booking providers: only
      // a response carrying an event id counts as booked for goals.
      const caldavEventId = (caldavResult.data as { eventId?: unknown } | undefined)?.eventId;
      if (caldavResult.ok && caldavEventId) {
        await fireGoalEvent(businessId, args.attendeePhone ?? fallbackPhone, {
          kind: "appointment_booked"
        });
      }
      return caldavResult;
    }

    const phoneFallback = args.attendeePhone ?? fallbackPhone ?? "";
    const descriptionLines = [
      args.notes ?? "",
      `Attendee: ${args.attendeeName}`,
      phoneFallback ? `Phone: ${phoneFallback}` : "",
      args.attendeeEmail ? `Email: ${args.attendeeEmail}` : ""
    ].filter((line) => line && line.trim().length > 0);
    // Always non-empty: the `Attendee:` line survives the filter for every
    // input (attendeeName is required), so no "omit the field" fallbacks
    // are needed below.
    const description = descriptionLines.join("\n");

    let eventId: string | null = null;
    let htmlLink: string | null = null;

    // Model's explicit timezone → business timezone → UTC (each validated
    // against Intl so conversion below can't throw on a junk zone).
    const eventTimezone = await resolveToolTimezone(businessId, args.timezone);

    // Normalize per provider instead of passing the model's string through.
    // The surfaces validate startIso/endIso as ISO 8601 with Z or an offset
    // (an unambiguous instant), but the providers want different shapes:
    // Google takes any RFC3339 instant (send UTC; timeZone drives display),
    // while Microsoft Graph's dateTimeTimeZone wants NAIVE local wall time
    // plus the zone name — an offset-carrying string sent raw is exactly
    // what made every Truly SMS booking attempt fail.
    const startInstant = new Date(args.startIso);
    const endInstant = new Date(args.endIso);

    // Book onto the shared NewCoworker calendar (created here on first
    // booking). Null = creation failed → book primary; never lose a booking.
    const shared = await ensureSharedCalendar(businessId);
    const googleCalendarPath = shared
      ? `/calendar/v3/calendars/${encodeURIComponent(shared.calendarId)}/events`
      : "/calendar/v3/calendars/primary/events";
    const microsoftEventsPath = shared
      ? `/v1.0/me/calendars/${encodeURIComponent(shared.calendarId)}/events`
      : "/v1.0/me/events";

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: googleCalendarPath,
          method: "POST",
          data: {
            summary: args.summary,
            description,
            start: { dateTime: startInstant.toISOString(), timeZone: eventTimezone },
            end: { dateTime: endInstant.toISOString(), timeZone: eventTimezone },
            attendees: args.attendeeEmail
              ? [{ email: args.attendeeEmail, displayName: args.attendeeName }]
              : undefined
          }
        }
      );
      if (!res) return { ok: false, detail: "calendar_not_connected" };
      const data = res.data as { id?: string; htmlLink?: string };
      eventId = data?.id ?? null;
      htmlLink = data?.htmlLink ?? null;
    } else {
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: microsoftEventsPath,
          method: "POST",
          data: {
            subject: args.summary,
            body: { contentType: "Text", content: description },
            start: { dateTime: wallClockInZone(startInstant, eventTimezone), timeZone: eventTimezone },
            end: { dateTime: wallClockInZone(endInstant, eventTimezone), timeZone: eventTimezone },
            attendees: args.attendeeEmail
              ? [
                  {
                    emailAddress: { address: args.attendeeEmail, name: args.attendeeName },
                    type: "required"
                  }
                ]
              : undefined
          }
        }
      );
      if (!res) return { ok: false, detail: "calendar_not_connected" };
      const data = res.data as { id?: string; webLink?: string };
      eventId = data?.id ?? null;
      htmlLink = data?.webLink ?? null;
    }

    // Goal Events: a real booking may fast-forward the lead's parked/queued
    // AiFlow runs to an "appointment booked" goal (skipping follow-up sends
    // between here and there). Only a CONFIRMED create fires it — a provider
    // response without an event id is not a booking. Best-effort inside
    // fireGoalEvent; the Calendly path above is exempt — a scheduling LINK is
    // not a booking.
    if (eventId) {
      await fireGoalEvent(businessId, args.attendeePhone ?? fallbackPhone, {
        kind: "appointment_booked"
      });
    }

    return {
      ok: true,
      data: {
        eventId,
        htmlLink,
        provider: conn.provider,
        calendar: shared ? "shared" : "primary"
      }
    };
  } catch (err) {
    logger.warn("calendar-tools/book failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "calendar_book_failed" };
  }
}
