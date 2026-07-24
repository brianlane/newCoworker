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
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import { maybeAlertUnassignedBooking } from "@/lib/calendar-tools/unassigned-booking-alert";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { graphTimeIso } from "@/lib/ai-flows/calendar-poll";
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
  /** Model-facing steering/recovery guidance riding with the result (the
   * voice bridge and every chat surface forward it to the model). */
  message?: string;
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
  /**
   * Skip the attendee duplicate guard: the customer has EXPLICITLY confirmed
   * they want an additional appointment on top of an existing upcoming one.
   * Without it, booking an attendee who already holds a different upcoming
   * slot refuses with `attendee_already_booked` (Truly, Jul 21 2026: the
   * model disowned a valid booking it had just made and created a second
   * one — the broker ended up double-booked).
   */
  allowAdditional?: boolean;
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
export async function resolveToolTimezone(
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
 * A booking start rendered for HUMANS (and the model to read back
 * verbatim): "Wednesday, July 22, 2026, 9:00 AM EDT". The Truly incident of
 * Jul 21 2026 was the model booking the right instant but narrating the
 * wrong DAY ("today") and then disowning its own valid booking — so
 * successful bookings and the duplicate guard both carry this string, and
 * the prompts tell the model to quote it instead of deriving the day
 * itself. Falls back to the raw ISO rather than ever throwing.
 */
export function formatBookingStartLocal(startIso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
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

/**
 * Raw busy blocks for a Google/Microsoft workspace connection across the
 * primary AND shared "NewCoworker" calendars — the exact fetch
 * findCalendarSlots always ran, extracted so the public booking page can
 * compute its own slot grid over the same free/busy truth. Returns null
 * when the Nango proxy yields nothing (treat as calendar_not_connected).
 *
 * Callers pass google/microsoft connections only (the resolver's vagaro /
 * calendly / caldav providers never reach this fetch).
 */
export async function getWorkspaceBusyBlocks(
  businessId: string,
  conn: { provider: string; connectionId: string; providerConfigKey: string },
  windowStart: Date,
  windowEnd: Date,
  opts: { availabilityViewInterval?: number } = {}
): Promise<Array<{ start: Date; end: Date }> | null> {
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
    if (!res) return null;
    const data = res.data as FreeBusyBody;
    const blocks = Object.values(data?.calendars ?? {}).flatMap((c) => c.busy ?? []);
    return blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

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
        availabilityViewInterval: opts.availabilityViewInterval ?? 30,
        schedules: ["me"]
      }
    }
  );
  if (!res) return null;
  type GraphBusy = {
    value?: Array<{
      scheduleItems?: Array<{ start?: { dateTime: string }; end?: { dateTime: string } }>;
    }>;
  };
  const data = res.data as GraphBusy;
  const items = data?.value?.[0]?.scheduleItems ?? [];
  let busy = items
    .filter((i) => i.start?.dateTime && i.end?.dateTime)
    .map((i) => ({
      start: new Date(graphTimeIso({ dateTime: i.start!.dateTime })!),
      end: new Date(graphTimeIso({ dateTime: i.end!.dateTime })!)
    }));

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
        .map((i) => ({
          start: new Date(graphTimeIso({ dateTime: i.start!.dateTime })!),
          end: new Date(graphTimeIso({ dateTime: i.end!.dateTime })!)
        }))
    );
  }
  return busy;
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

    const workspaceBusy = await getWorkspaceBusyBlocks(businessId, conn, windowStart, windowEnd, {
      availabilityViewInterval: args.durationMinutes
    });
    if (workspaceBusy === null) return { ok: false, detail: "calendar_not_connected" };
    busy = workspaceBusy;

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
 * Stored contact identity (display name + email) for the attendee phone,
 * alias-aware. Best effort: nulls on no contact, blank fields, or any
 * lookup failure — the booking proceeds with the model-supplied values.
 */
async function storedAttendeeContact(
  businessId: string,
  phone: string
): Promise<{ name: string | null; email: string | null }> {
  try {
    const row = await getCustomerMemory(businessId, phone);
    const name = row?.display_name?.trim();
    const email = row?.email?.trim();
    return {
      name: name && name.length > 0 ? name : null,
      email: email && email.length > 0 ? email : null
    };
  } catch (err) {
    logger.warn("calendar-tools/book: stored-contact lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { name: null, email: null };
  }
}

export type BookAppointmentOptions = {
  /**
   * Which customer-facing AI surface is booking. When set, a CONFIRMED
   * fresh booking for a contact no teammate owns fans out the
   * unassigned-booking owner alert (toggle `unassigned_booking_alerts`,
   * on by default). Owner-initiated surfaces (dashboard inline, dashboard_
   * Rowboat twin, MCP) leave it unset — the owner already knows what they
   * booked. `already_booked` dedupe retries never re-alert.
   */
  alertSurface?: "voice" | "sms" | "webchat";
};

export async function bookCalendarAppointment(
  businessId: string,
  rawArgs: BookAppointmentArgs,
  fallbackPhone?: string | null,
  opts: BookAppointmentOptions = {}
): Promise<CalendarToolResult> {
  if (new Date(rawArgs.endIso).getTime() <= new Date(rawArgs.startIso).getTime()) {
    return { ok: false, detail: "invalid_window" };
  }

  // Preferred-name rule (Truly Issue 6): once a contact exists, the stored
  // display name wins over whatever name the model carried in from a lead
  // form or the conversation — invites stop flip-flopping between "Juhu"
  // and "Muhammad Fahad Juhu" for the same person.
  //
  // Email backfill (Truly, Jul 15 2026): the voice model rarely collects an
  // email mid-call, so bookings shipped with no attendee — the provider
  // sent NO calendar invite while the assistant promised one. When the
  // stored contact already has an email (lead form, SMS follow-up), use it
  // so the invite is real. The model's explicit attendeeEmail still wins.
  const attendeePhone = (rawArgs.attendeePhone ?? fallbackPhone ?? "").trim();
  const stored = attendeePhone
    ? await storedAttendeeContact(businessId, attendeePhone)
    : { name: null, email: null };
  const args: BookAppointmentArgs = {
    ...rawArgs,
    ...(stored.name ? { attendeeName: stored.name } : {}),
    ...(!rawArgs.attendeeEmail?.trim() && stored.email ? { attendeeEmail: stored.email } : {})
  };

  /** Stamp booked results with the human-readable local start (+ zone) so
   * the model reads the tool's day/time back verbatim instead of deriving
   * "today"/"tomorrow" itself (the Truly Jul 21 mislabeled-day incident). */
  const withStartLocal = async (result: CalendarToolResult): Promise<CalendarToolResult> => {
    const d = (result.data ?? {}) as Record<string, unknown>;
    const booked =
      result.ok &&
      ((typeof d.eventId === "string" && d.eventId.length > 0) ||
        result.detail === "already_booked");
    if (!booked) return result;
    const tz = await resolveToolTimezone(businessId, args.timezone);
    return {
      ...result,
      data: { ...d, startLocal: formatBookingStartLocal(args.startIso, tz) }
    };
  };

  // Attendee duplicate guard (Truly, Jul 21 2026): prompts alone failed
  // three times in one week — the model books a SECOND slot to "fix" or
  // "move" an existing one, and the owner's calendar ends up double-booked.
  // The shared attendee-bookings lookup sees every platform booking (any
  // provider, via the dedupe ledger) plus the connected provider's
  // off-platform bookings (Calendly/Vagaro adapters), so a request for an
  // attendee who already holds a DIFFERENT upcoming slot refuses with
  // reschedule/cancel guidance. The exact same slot falls through to the
  // idempotency ledger below (a timeout retry must keep answering
  // `already_booked`), and `allowAdditional` is the explicit escape hatch
  // for a genuinely additional appointment. Fail-open by module contract:
  // a lookup hiccup books as before.
  if (!args.allowAdditional) {
    const existing = await findUpcomingBookingsForAttendee(
      businessId,
      {
        phones: attendeePhone ? [attendeePhone] : [],
        email: args.attendeeEmail?.trim().toLowerCase() || null,
        name: args.attendeeName
      },
      {},
      { mode: "detail" }
    );
    const requestedStartMs = new Date(args.startIso).getTime();
    const nowMs = Date.now();
    // A request that repeats one of the attendee's EXISTING slot times is a
    // retry, not a duplicate: skip the guard entirely so it falls through to
    // the idempotency ledger's `already_booked` answer — even when the
    // attendee holds OTHER upcoming slots too (e.g. booked two via
    // allowAdditional; Bugbot Medium on PR #824).
    const repeatsExistingSlot = existing.some((b) => {
      const ms = Date.parse(b.startIso);
      return Number.isFinite(ms) && ms === requestedStartMs;
    });
    const conflict = repeatsExistingSlot
      ? undefined
      : existing.find((b) => {
          const ms = Date.parse(b.startIso);
          return Number.isFinite(ms) && ms > nowMs;
        });
    if (conflict) {
      const tz = await resolveToolTimezone(businessId, args.timezone);
      const existingStartLocal = formatBookingStartLocal(conflict.startIso, tz);
      return {
        ok: false,
        detail: "attendee_already_booked",
        data: {
          existingEventId: conflict.eventId,
          existingStartIso: conflict.startIso,
          existingStartLocal,
          existingProvider: conflict.provider
        },
        message:
          `This person already has an upcoming appointment: ${existingStartLocal}. Do NOT ` +
          "book another one. Tell them about that existing time and ask what they want: " +
          "keep it (book nothing), move it (calendar_reschedule_appointment — never book a " +
          "second slot to move one), or cancel it (calendar_cancel_appointment). Only if " +
          "they explicitly confirm they want an ADDITIONAL separate appointment, call " +
          "calendar_book_appointment again with allowAdditional set to true."
      };
    }
  }

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
    return withStartLocal({
      ok: true,
      detail: "already_booked",
      data: {
        eventId: claim.eventId,
        deduplicated: true,
        // The prompts key invite language off inviteEmail, and a timeout
        // retry lands here — the original create ran the same email merge
        // on the same args, so the merged email IS what rode the event.
        inviteEmail: args.attendeeEmail?.trim() || null
      }
    });
  }
  if (claim?.kind === "in_flight") {
    // Another attempt is booking this exact slot right now. Refuse without
    // touching the provider; the in-flight attempt confirms (or its claim
    // expires and a later retry books cleanly).
    return { ok: false, detail: "booking_in_progress" };
  }

  const result = await bookOnProvider(businessId, args, fallbackPhone);

  if (claim?.kind === "claimed") {
    const booked = result.data as
      | { eventId?: unknown; zoomMeetingId?: unknown }
      | undefined;
    const bookedEventId = booked?.eventId;
    if (result.ok && typeof bookedEventId === "string" && bookedEventId.length > 0) {
      // The Zoom meeting id (when the booking got one) rides on the ledger
      // row so reschedule/cancel can move/delete the meeting with the event.
      await confirmBookingDedupe(
        claim.id,
        bookedEventId,
        typeof booked?.zoomMeetingId === "string" ? booked.zoomMeetingId : null
      );
    } else {
      await releaseBookingDedupe(claim.id);
    }
  }
  const finalResult = await withStartLocal(result);

  // Unassigned-booking owner alert (Truly, Jul 21 2026): a customer-facing
  // AI surface just confirmed a REAL appointment — if no teammate owns this
  // contact, tell the owner NOW, or nobody shows up. Fresh confirmed creates
  // only (link-mode and failures carry no event; dedupe retries returned
  // above). Best-effort inside the core: never affects the booking result.
  if (opts.alertSurface && finalResult.ok) {
    const d = (finalResult.data ?? {}) as Record<string, unknown>;
    if (typeof d.eventId === "string" && d.eventId.length > 0) {
      await maybeAlertUnassignedBooking(businessId, {
        attendeeName: args.attendeeName,
        attendeePhone: attendeePhone || null,
        attendeeEmail: args.attendeeEmail?.trim() || null,
        startIso: new Date(args.startIso).toISOString(),
        // Guaranteed present: withStartLocal stamps every confirmed create,
        // and this block only runs behind the same ok+eventId condition.
        startLocal: d.startLocal as string,
        summary: args.summary,
        eventId: d.eventId,
        surface: opts.alertSurface
      });
    }
  }
  return finalResult;
}

async function bookOnProvider(
  businessId: string,
  args: BookAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  // Hoisted for the catch block: a Zoom meeting created before a provider
  // failure must be cleaned up, or it lingers on the owner's account with
  // no calendar event referencing it.
  let orphanZoomMeetingId: string | null = null;
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

    // Zoom decorator for the REAL-booking calendar providers below (CalDAV,
    // Google, Microsoft): with a connected Zoom account — first-party
    // zoom_connections, or a legacy Nango link — the appointment gets a
    // scheduled Zoom meeting whose join link rides the event body and the
    // tool result (so the agent texts/emails it in the confirmation).
    // Best-effort by contract: null means "no video link", never a failed
    // booking. Vagaro (in-person services) and Calendly (link-mode, no
    // confirmed event) stay Zoom-free.
    const zoomMeeting = await createZoomMeetingForBooking(businessId, {
      topic: args.summary,
      startIso: args.startIso,
      endIso: args.endIso,
      ...(args.notes ? { agenda: args.notes } : {})
    });
    orphanZoomMeetingId = zoomMeeting?.meetingId ?? null;
    const zoomLine = zoomMeeting ? `Video call (Zoom): ${zoomMeeting.joinUrl}` : "";
    const zoomData = zoomMeeting
      ? { zoomMeetingId: zoomMeeting.meetingId, zoomJoinUrl: zoomMeeting.joinUrl }
      : {};

    if (conn.provider === "caldav") {
      // Real booking on the owner's CalDAV calendar (direct, no Nango).
      const caldavPhone = args.attendeePhone ?? fallbackPhone ?? "";
      const caldavDescription = [
        args.notes ?? "",
        zoomLine,
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
        orphanZoomMeetingId = null;
        await fireGoalEvent(businessId, args.attendeePhone ?? fallbackPhone, {
          kind: "appointment_booked"
        });
        return {
          ...caldavResult,
          // CalDAV events carry the attendee in the description only — the
          // server emails nobody. Explicit null so the model never promises
          // an invite on this provider.
          data: { ...(caldavResult.data as Record<string, unknown>), inviteEmail: null, ...zoomData }
        };
      }
      if (zoomMeeting) {
        await deleteZoomMeetingForBooking(businessId, zoomMeeting.meetingId);
        orphanZoomMeetingId = null;
      }
      return caldavResult;
    }

    const phoneFallback = args.attendeePhone ?? fallbackPhone ?? "";
    const descriptionLines = [
      args.notes ?? "",
      zoomLine,
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
      if (!res) {
        if (zoomMeeting) {
          await deleteZoomMeetingForBooking(businessId, zoomMeeting.meetingId);
          orphanZoomMeetingId = null;
        }
        return { ok: false, detail: "calendar_not_connected" };
      }
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
      if (!res) {
        if (zoomMeeting) {
          await deleteZoomMeetingForBooking(businessId, zoomMeeting.meetingId);
          orphanZoomMeetingId = null;
        }
        return { ok: false, detail: "calendar_not_connected" };
      }
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

    // A truthy proxy response WITHOUT an event id is not a confirmed booking:
    // nothing references the meeting and the ledger row never confirms, so
    // the meeting is deleted (same rule as the CalDAV branch) and the result
    // carries no join link.
    if (!eventId && zoomMeeting) {
      await deleteZoomMeetingForBooking(businessId, zoomMeeting.meetingId);
    }
    orphanZoomMeetingId = null;
    return {
      ok: true,
      data: {
        eventId,
        htmlLink,
        provider: conn.provider,
        calendar: shared ? "shared" : "primary",
        // Ground truth for "will a calendar invite go out": the provider
        // emails an invitation ONLY when the event has an attendee. The
        // model must not promise an invite when this is null.
        inviteEmail: eventId ? args.attendeeEmail?.trim() || null : null,
        ...(eventId ? zoomData : {})
      }
    };
  } catch (err) {
    logger.warn("calendar-tools/book failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    if (orphanZoomMeetingId) {
      await deleteZoomMeetingForBooking(businessId, orphanZoomMeetingId);
    }
    return { ok: false, detail: "calendar_book_failed" };
  }
}
