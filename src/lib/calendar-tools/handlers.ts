import { randomUUID } from "node:crypto";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  workspaceProxyForBusiness,
  workspaceProxyStatusForBusiness
} from "@/lib/workspace/proxy";
import { getBusinessTimezone, isGoogleMeetEnabled } from "@/lib/db/businesses";
import {
  buildMeetConferenceRequest,
  MEET_CONFERENCE_DATA_VERSION,
  resolveMeetJoinUrl
} from "@/lib/google/meet";
import {
  ensureSharedCalendar,
  getSharedCalendar,
  mirrorBookingToSharedCalendar
} from "@/lib/calendar-tools/shared-calendar";
import { createCalendlyBookingLink, findCalendlySlots } from "@/lib/calendar-tools/calendly";
import { bookVagaroAppointment, findVagaroSlots } from "@/lib/calendar-tools/vagaro";
import { bookAcuityAppointment, findAcuitySlots } from "@/lib/calendar-tools/acuity";
import { bookCaldavAppointment, getCaldavBusyBlocks } from "@/lib/calendar-tools/caldav";
import {
  bookingAttendeeKey,
  claimBookingDedupe,
  confirmBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { findUpcomingBookingsForAttendee } from "@/lib/calendar-tools/attendee-bookings";
import { maybeAlertUnassignedBooking } from "@/lib/calendar-tools/unassigned-booking-alert";
import { resolveWaitlistAfterBooking } from "@/lib/calendar-tools/waitlist-resolve";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";
import { fireLifecycleStage } from "@/lib/pipelines/lifecycle-hooks";
import {
  createZoomMeetingForBooking,
  deleteZoomMeetingForBooking
} from "@/lib/zoom/meetings";
import { graphTimeIso } from "@/lib/ai-flows/calendar-poll";
import { logger } from "@/lib/logger";

/**
 * How a just-booked attendee is identified to the goal engine: their phone
 * when we have one, otherwise their email.
 *
 * A booking is the milestone that stops a follow-up cadence, and a lead with
 * no phone books too. Passing only the phone meant their `appointment_booked`
 * never fired, so the cadence kept emailing someone who had already booked.
 */
function bookedLeadIdentity(
  args: { attendeePhone?: string; attendeeEmail?: string },
  fallbackPhone: string | null | undefined
): string | null {
  const phone = args.attendeePhone?.trim() || (fallbackPhone ?? "").trim();
  if (phone) return phone;
  return args.attendeeEmail?.trim() || null;
}

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
 * Vagaro (vagaro.ts) and Acuity (acuity.ts) connections support REAL
 * booking: availability search + appointment creation on the merchant's own
 * book via each provider's direct API (per-tenant credentials in
 * vagaro_connections / acuity_connections, no Nango involved). Acuity's
 * availability is DATE-scoped rather than range-scoped, so its slot search
 * fans out day by day; see that module for how the fan-out is bounded.
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
  /** Vagaro/Acuity only: explicit service to search (defaults to the owner's pick). */
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
  /** Vagaro/Acuity only: explicit service to book (defaults to the owner's pick). */
  serviceId?: string;
  /**
   * Skip the attendee duplicate guard: the customer has EXPLICITLY confirmed
   * they want an additional appointment on top of an existing upcoming one.
   * Without it, booking an attendee who already holds a different upcoming
   * slot refuses with `attendee_already_booked` (Truly, Jul 21 2026: the
   * model disowned a valid booking it had just made and created a second
   * one, the broker ended up double-booked).
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
 * bad zone. Looked up per call (single indexed read) and never fatal, a
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
 * wrong DAY ("today") and then disowning its own valid booking, so
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
 * "YYYY-MM-DDTHH:mm:ss" wall-clock time of an instant in a timezone, the
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

/**
 * UTC instant of local midnight opening `isoDate` (YYYY-MM-DD) in `timeZone`.
 *
 * Google reports all-day events as bare dates, so blocking one means picking
 * the instants "that day" spans. Offset correction converges in two passes
 * wherever local midnight exists; in a zone whose DST jump skips midnight
 * itself the result settles within the hour beside it, and either edge sits
 * deep in the night where no bookable slot lives. A malformed date yields an
 * Invalid Date for the caller to drop. The caller guarantees a valid IANA
 * zone via resolveToolTimezone, the same contract wallClockInZone carries.
 */
export function zonedMidnightUtc(isoDate: string, timeZone: string): Date {
  const utcGuess = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(utcGuess)) return new Date(Number.NaN);
  let ms = utcGuess;
  for (let pass = 0; pass < 2; pass += 1) {
    const wallMs = Date.parse(`${wallClockInZone(new Date(ms), timeZone)}Z`);
    if (wallMs === utcGuess) break;
    ms -= wallMs - utcGuess;
  }
  return new Date(ms);
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
 * (in the requester's timezone) over :15/:45, a lead offered "5:19 PM"
 * reads it as a glitch, not availability. Every UTC offset in use is a
 * multiple of 15 minutes, so UTC quarter boundaries ARE local quarter
 * boundaries everywhere; only the :00/:30 classification needs the zone
 * (e.g. Kathmandu's +05:45 maps UTC :15 to local :00).
 *
 * Exactly one of the first two quarter boundaries after the gap opens is a
 * :00/:30, take it when the appointment still fits (at most 15 minutes
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
  // No :00/:30 fits, fall back to the earliest quarter boundary. Only
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
 * primary AND shared "NewCoworker" calendars, the exact fetch
 * findCalendarSlots always ran, extracted so the public booking page can
 * compute its own slot grid over the same free/busy truth. Returns null
 * when the Nango proxy yields nothing (treat as calendar_not_connected).
 *
 * Callers pass google/microsoft connections only (the resolver's vagaro /
 * calendly / caldav providers never reach this fetch).
 *
 * For Google, freeBusy alone is not the whole truth: it hides all-day
 * events (Google defaults them to "Free") and can hide out-of-office
 * events, so a per-calendar day-block read supplements it. See
 * readGoogleDayBlockBusy for the rules.
 */
/**
 * True when a thrown proxy error carries a real HTTP status, i.e. the provider
 * answered and refused.
 *
 * The distinction is the whole point of the getSchedule fallback: "Microsoft
 * says this mailbox has no getSchedule" is worth retrying a different way,
 * while "we never reached Microsoft" is not, and trying anyway would turn one
 * timeout into two.
 */
function isProviderRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const response = (err as { response?: unknown }).response;
  if (!response || typeof response !== "object") return false;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status <= 599;
}

/** Graph events that do NOT make the owner busy. */
const GRAPH_FREE_SHOW_AS = new Set(["free", "workingElsewhere"]);

/**
 * Page size for calendarView busy reads, and the page budget behind it.
 *
 * Graph defaults calendarView to TEN items and hides the rest behind
 * `@odata.nextLink`. Ten is nothing across a booking window, and here the
 * truncation runs one way only: an event we never see reads as FREE, so a
 * first-page-only read hands out slots on top of real meetings. 250 matches the
 * calendarView read in reschedule.ts. The page budget bounds a pathological
 * mailbox; 1000 events inside one booking window is far past any real tenant.
 */
const CALENDAR_VIEW_PAGE_SIZE = 250;
const CALENDAR_VIEW_MAX_PAGES = 4;

/**
 * A free/busy read, and whether it is the WHOLE answer.
 *
 * `complete: false` means paging was cut short, so `busy` is a real but partial
 * list: everything in it is genuinely busy, and there is more that was not
 * read. That distinction has to survive the return, because the two kinds of
 * caller need opposite things from it and neither answer is safe for both.
 *
 * A caller with no other availability signal (the `calendar_find_slots` tool,
 * waitlist fill) must REFUSE an incomplete read. It would otherwise offer a
 * time that only looks free because the event covering it was never read, and
 * unread always reads as free.
 *
 * The public booking page must USE it. There, provider busy is additive on top
 * of the booking ledger and a cached snapshot, and an unreadable provider
 * degrades to those instead of taking the page down. A partial list is strictly
 * more conservative than that degradation, so discarding it would hand out MORE
 * taken slots, not fewer. What it must not do is persist an under-report as
 * last-known-good.
 *
 * The budget is reachable by a real tenant, not just a pathological one: a
 * booking window runs to `max_advance_days + 2` and max_advance_days caps at
 * 60, so a clinic or salon at 20 to 40 appointments a day clears 1000 events
 * inside one window. Raising the budget instead would put twenty-odd sequential
 * Graph round trips in front of a public page load, which is why the answer is
 * to report incompleteness rather than to page harder.
 */
export type WorkspaceBusyRead = {
  busy: Array<{ start: Date; end: Date }>;
  complete: boolean;
};

/**
 * Busy blocks from a Graph calendarView window, following Graph's paging.
 *
 * Used for the shared "NewCoworker" calendar, and as the personal-account
 * substitute for getSchedule. Unlike getSchedule, which returns availability
 * directly, this returns EVENTS, so `showAs` has to be honored here: an event
 * the owner marked free or working-elsewhere is not busy, and treating it as
 * busy would quietly delete real availability.
 *
 * Cancelled events are dropped for the same reason.
 *
 * Returns null when there is no usable connection. A read that ran out of page
 * budget comes back with `complete: false` instead: the blocks are real, there
 * are just more of them unread, and only the caller knows whether an
 * under-report is survivable. See WorkspaceBusyRead.
 */
async function readCalendarViewBusy(
  businessId: string,
  conn: { connectionId: string; providerConfigKey: string },
  endpoint: string,
  windowStart: Date,
  windowEnd: Date
): Promise<WorkspaceBusyRead | null> {
  type GraphView = {
    value?: Array<{
      start?: { dateTime: string };
      end?: { dateTime: string };
      showAs?: string;
      isCancelled?: boolean;
    }>;
    "@odata.nextLink"?: string;
  };

  const busy: Array<{ start: Date; end: Date }> = [];
  // The first page carries the window as params. Later pages come from
  // nextLink, which already embeds the window plus a $skiptoken, so it is sent
  // as a bare endpoint with nothing merged back on top of it.
  let next: string | null = null;

  for (let page = 0; page < CALENDAR_VIEW_MAX_PAGES; page += 1) {
    const res = await workspaceProxyForBusiness(
      businessId,
      { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
      next
        ? { endpoint: next, method: "GET" }
        : {
            endpoint,
            method: "GET",
            params: {
              startDateTime: windowStart.toISOString(),
              endDateTime: windowEnd.toISOString(),
              $top: String(CALENDAR_VIEW_PAGE_SIZE)
            }
          }
    );
    if (!res) return null;

    const data = (res.data ?? null) as GraphView | null;
    for (const i of data?.value ?? []) {
      if (!i.start?.dateTime || !i.end?.dateTime) continue;
      if (i.isCancelled === true) continue;
      if (typeof i.showAs === "string" && GRAPH_FREE_SHOW_AS.has(i.showAs)) continue;
      busy.push({
        start: new Date(graphTimeIso({ dateTime: i.start.dateTime })!),
        end: new Date(graphTimeIso({ dateTime: i.end.dateTime })!)
      });
    }

    const link = data?.["@odata.nextLink"];
    if (!link) return { busy, complete: true };
    // nextLink is an absolute Graph URL; the proxy wants path + query.
    const u = new URL(link);
    next = u.pathname + u.search;
  }

  // Budget spent with pages still outstanding. The blocks gathered so far are
  // real, so they are handed back rather than discarded; `complete: false` is
  // what stops a caller from reading the gap as free time.
  logger.warn("calendarView exceeded its page budget; busy list is an under-report", {
    businessId,
    providerConfigKey: conn.providerConfigKey,
    pages: CALENDAR_VIEW_MAX_PAGES,
    eventsSeen: busy.length
  });
  return { busy, complete: false };
}

/** Google events that annotate a day rather than claim the owner's time. */
const GOOGLE_NON_BLOCKING_EVENT_TYPES = new Set(["birthday", "workingLocation"]);

/**
 * Google events the owner reads as "that day is taken" but freeBusy never
 * reports.
 *
 * freeBusy only carries OPAQUE spans, and Google flips the default to
 * transparent ("Free") for every all-day event created in its UI, so the
 * banner an owner drags across a day ("OOO", a conference, a closure) is
 * invisible to it while the same hours typed as a 9-to-9 event block. That
 * is exactly backwards for a booking surface: the Aug 2026 report was the
 * founder's own out-of-office day being offered to visitors.
 *
 * Rules: an all-day event blocks its whole business-local days regardless of
 * transparency (the Free default means transparency carries no intent
 * there), and a timed out-of-office event blocks its span (freeBusy may or
 * may not report those; a duplicate block is harmless to every consumer).
 * Timed events of any other kind stay freeBusy's call, so an owner who
 * marks a timed event Free keeps that choice, mirroring the Graph `showAs`
 * rule above. Birthday and working-location events annotate a day rather
 * than claim it, and cancelled instances claim nothing.
 *
 * Same page budget as the Graph calendarView read, same `complete: false`
 * under-report contract when it runs out.
 */
async function readGoogleDayBlockBusy(
  businessId: string,
  conn: { connectionId: string; providerConfigKey: string },
  calendarId: string,
  windowStart: Date,
  windowEnd: Date,
  timeZone: string
): Promise<WorkspaceBusyRead | null> {
  type GoogleEventsPage = {
    items?: Array<{
      status?: string;
      eventType?: string;
      start?: { date?: string; dateTime?: string };
      end?: { date?: string; dateTime?: string };
    }>;
    nextPageToken?: string;
  };

  const busy: Array<{ start: Date; end: Date }> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < CALENDAR_VIEW_MAX_PAGES; page += 1) {
    const res = await workspaceProxyForBusiness(businessId, conn, {
      endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "GET",
      params: {
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        // Recurring "closed every Monday" style events arrive expanded.
        singleEvents: "true",
        maxResults: String(CALENDAR_VIEW_PAGE_SIZE),
        fields: "nextPageToken,items(status,eventType,start,end)",
        ...(pageToken ? { pageToken } : {})
      }
    });
    if (!res) return null;

    const data = (res.data ?? null) as GoogleEventsPage | null;
    for (const i of data?.items ?? []) {
      if (i.status === "cancelled") continue;
      if (i.eventType && GOOGLE_NON_BLOCKING_EVENT_TYPES.has(i.eventType)) continue;
      if (i.start?.date && i.end?.date) {
        // All-day: bare dates, end exclusive. A malformed date (a shape
        // Google does not send) drops the event rather than pushing an
        // Invalid Date block, which compares as never-clear and would
        // silently freeze the whole window.
        const start = zonedMidnightUtc(i.start.date, timeZone);
        const end = zonedMidnightUtc(i.end.date, timeZone);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        busy.push({ start, end });
        continue;
      }
      if (i.eventType === "outOfOffice" && i.start?.dateTime && i.end?.dateTime) {
        busy.push({ start: new Date(i.start.dateTime), end: new Date(i.end.dateTime) });
      }
    }

    const next = data?.nextPageToken;
    if (!next) return { busy, complete: true };
    pageToken = next;
  }

  logger.warn("google day-block read exceeded its page budget; busy list is an under-report", {
    businessId,
    calendarId,
    pages: CALENDAR_VIEW_MAX_PAGES,
    eventsSeen: busy.length
  });
  return { busy, complete: false };
}

export async function getWorkspaceBusyBlocks(
  businessId: string,
  conn: { provider: string; connectionId: string; providerConfigKey: string },
  windowStart: Date,
  windowEnd: Date,
  opts: { availabilityViewInterval?: number } = {}
): Promise<WorkspaceBusyRead | null> {
  // Read-only: never creates the shared calendar from the search path.
  const shared = await getSharedCalendar(businessId);

  if (conn.provider === "google") {
    const link = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
    const calendarIds = ["primary", ...(shared ? [shared.calendarId] : [])];
    // All-day events resolve at business-local midnights: the day grid every
    // consumer offers from is business-local, and "out Friday" means THAT
    // Friday wherever the calendar's own zone setting happens to sit.
    const timeZone = await resolveToolTimezone(businessId, undefined);
    // freeBusy and the per-calendar day-block reads are independent, and a
    // public page load sits behind this fetch, so they run concurrently.
    const [res, ...dayReads] = await Promise.all([
      workspaceProxyForBusiness(businessId, link, {
        endpoint: "/calendar/v3/freeBusy",
        method: "POST",
        data: {
          timeMin: windowStart.toISOString(),
          timeMax: windowEnd.toISOString(),
          items: calendarIds.map((id) => ({ id }))
        }
      }),
      ...calendarIds.map(async (calendarId): Promise<WorkspaceBusyRead | null> => {
        // A failed day-block read must not take down the freeBusy answer it
        // supplements. `complete: false` already says exactly what happened:
        // every block returned is real, and more went unread.
        try {
          return await readGoogleDayBlockBusy(
            businessId,
            link,
            calendarId,
            windowStart,
            windowEnd,
            timeZone
          );
        } catch (err) {
          logger.warn("google day-block read failed; busy list is an under-report", {
            businessId,
            calendarId,
            error: err instanceof Error ? err.message : String(err)
          });
          return null;
        }
      })
    ]);
    if (!res) return null;
    const data = res.data as FreeBusyBody;
    const blocks = Object.values(data?.calendars ?? {}).flatMap((c) => c.busy ?? []);
    // freeBusy answers for every calendar in one response, with no paging.
    const busy = blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    let complete = true;
    for (const read of dayReads) {
      if (read === null) {
        complete = false;
        continue;
      }
      busy.push(...read.busy);
      complete = complete && read.complete;
    }
    return { busy, complete };
  }

  // Microsoft Graph getSchedule: POST /me/calendar/getSchedule.
  //
  // Work/school only. A PERSONAL Microsoft account has no getSchedule at all
  // and rejects the call, so this is wrapped: without the fallback below, every
  // caller degrades to "calendar_lookup_failed" and a personal-Outlook tenant
  // silently loses all availability (no slot offers, an unreadable booking
  // page, and a waitlist that treats every slot as taken forever).
  let res: Awaited<ReturnType<typeof workspaceProxyForBusiness>> = null;
  let getScheduleFailed = false;
  try {
    res = await workspaceProxyForBusiness(
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
  } catch (err) {
    // Only a PROVIDER rejection falls back. A transport failure (no response
    // at all) is not evidence the mailbox lacks getSchedule, and retrying it
    // against a different endpoint would just double the outage.
    if (!isProviderRejection(err)) throw err;
    getScheduleFailed = true;
    logger.info("getSchedule unavailable; falling back to calendarView", {
      businessId,
      providerConfigKey: conn.providerConfigKey
    });
  }

  let busy: Array<{ start: Date; end: Date }>;
  // Every read that follows has to agree before the answer counts as whole.
  let complete = true;
  if (getScheduleFailed) {
    // calendarView is supported on personal accounts. Busy is derived from the
    // events themselves, so `showAs` decides: an event the owner marked free
    // must not block a slot the way getSchedule would never have reported it.
    const fallback = await readCalendarViewBusy(
      businessId,
      conn,
      "/v1.0/me/calendarView",
      windowStart,
      windowEnd
    );
    if (fallback === null) return null;
    busy = fallback.busy;
    complete = fallback.complete;
  } else {
    if (!res) return null;
    type GraphBusy = {
      value?: Array<{
        scheduleItems?: Array<{ start?: { dateTime: string }; end?: { dateTime: string } }>;
      }>;
    };
    const data = res.data as GraphBusy;
    const items = data?.value?.[0]?.scheduleItems ?? [];
    busy = items
      .filter((i) => i.start?.dateTime && i.end?.dateTime)
      .map((i) => ({
        start: new Date(graphTimeIso({ dateTime: i.start!.dateTime })!),
        end: new Date(graphTimeIso({ dateTime: i.end!.dateTime })!)
      }));
  }

  // getSchedule only covers the default calendar; pull the shared
  // NewCoworker calendar's events separately and merge them in.
  if (shared) {
    const sharedBusy = await readCalendarViewBusy(
      businessId,
      conn,
      `/v1.0/me/calendars/${encodeURIComponent(shared.calendarId)}/calendarView`,
      windowStart,
      windowEnd
    );
    // A shared calendar that cannot be reached at all fails the whole lookup
    // rather than merging nothing. This is where OUR OWN bookings live, so
    // silently skipping it is the one case guaranteed to double-book. A deleted
    // calendar already behaved this way (404s throw, and every caller catches).
    if (sharedBusy === null) return null;
    busy = busy.concat(sharedBusy.busy);
    // Partial on either calendar makes the merged answer partial.
    complete = complete && sharedBusy.complete;
  }
  return { busy, complete };
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

    if (conn.provider === "acuity") {
      const timezone = await resolveToolTimezone(businessId, args.timezone);
      return findAcuitySlots(businessId, {
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
    // An under-report is refused here. This tool has no second availability
    // source to fall back on, so offering from a partial busy list means
    // offering a time that is only free because its event went unread.
    if (!workspaceBusy.complete) return { ok: false, detail: "calendar_lookup_failed" };
    busy = workspaceBusy.busy;

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
 * lookup failure, the booking proceeds with the model-supplied values.
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
   * Rowboat twin, MCP) leave it unset, the owner already knows what they
   * booked. `already_booked` dedupe retries never re-alert.
   */
  alertSurface?: "voice" | "sms" | "webchat";
  /**
   * Keep the caller-supplied attendeeName even when a stored contact
   * display name exists. The preferred-name rule (stored name wins) exists
   * for MODEL-carried names that drift mid-conversation; the public
   * booking page passes a name the visitor typed seconds ago, which must
   * not be overridden by a stale CRM entry. Stored-email backfill is
   * unaffected.
   */
  trustProvidedName?: boolean;
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
  // form or the conversation, invites stop flip-flopping between "Juhu"
  // and "Muhammad Fahad Juhu" for the same person.
  //
  // Email backfill (Truly, Jul 15 2026): the voice model rarely collects an
  // email mid-call, so bookings shipped with no attendee, the provider
  // sent NO calendar invite while the assistant promised one. When the
  // stored contact already has an email (lead form, SMS follow-up), use it
  // so the invite is real. The model's explicit attendeeEmail still wins.
  const attendeePhone = (rawArgs.attendeePhone ?? fallbackPhone ?? "").trim();
  const stored = attendeePhone
    ? await storedAttendeeContact(businessId, attendeePhone)
    : { name: null, email: null };
  const args: BookAppointmentArgs = {
    ...rawArgs,
    ...(stored.name && !opts.trustProvidedName ? { attendeeName: stored.name } : {}),
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
  // three times in one week, the model books a SECOND slot to "fix" or
  // "move" an existing one, and the owner's calendar ends up double-booked.
  // The shared attendee-bookings lookup sees every platform booking (any
  // provider, via the dedupe ledger) plus the connected provider's
  // off-platform bookings (Calendly/Vagaro/Acuity adapters), so a request for an
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
    // the idempotency ledger's `already_booked` answer, even when the
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
          "keep it (book nothing), move it (calendar_reschedule_appointment, never book a " +
          "second slot to move one), or cancel it (calendar_cancel_appointment). Only if " +
          "they explicitly confirm they want an ADDITIONAL separate appointment, call " +
          "calendar_book_appointment again with allowAdditional set to true."
      };
    }
  }

  // Idempotency guard (2026-07-13 incident): a worker-retried model turn
  // re-runs its tool calls, and provider create APIs are not idempotent,
  // one customer confirmation produced FOUR identical Outlook events. Claim
  // the (business, attendee, start) slot before creating; a repeat attempt
  // inside the window returns the recorded event instead of booking again.
  // Fail-open: a null claim (ledger unavailable) books without dedupe.
  // Calendly is naturally exempt, its link-mode result never confirms an
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
        // retry lands here, the original create ran the same email merge
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
      | {
          eventId?: unknown;
          zoomMeetingId?: unknown;
          provider?: unknown;
          videoJoinUrl?: unknown;
          videoProvider?: unknown;
        }
      | undefined;
    const bookedEventId = booked?.eventId;
    if (result.ok && typeof bookedEventId === "string" && bookedEventId.length > 0) {
      // Put the booking on the shared "NewCoworker" calendar so the whole
      // team sees it. Only for providers that are NOT the calendar host:
      // when Google or Microsoft took the booking, bookOnProvider already
      // wrote it to that very calendar, and mirroring would duplicate it.
      // Best-effort by contract, and the id rides the ledger row for the
      // same reason the Zoom meeting id does: without a handle, reschedule
      // and cancel cannot keep it in step, and a mirror left behind after a
      // cancellation shows the team an appointment that is not happening.
      const bookedProvider = typeof booked?.provider === "string" ? booked.provider : "";
      const mirrorEventId = await mirrorBookingToSharedCalendar(businessId, bookedProvider, {
        summary: args.summary,
        startIso: args.startIso,
        endIso: args.endIso,
        attendeeName: args.attendeeName,
        attendeePhone: args.attendeePhone ?? fallbackPhone ?? null,
        attendeeEmail: args.attendeeEmail ?? null,
        notes: args.notes ?? null
      });
      await confirmBookingDedupe(claim.id, bookedEventId, {
        zoomMeetingId: typeof booked?.zoomMeetingId === "string" ? booked.zoomMeetingId : null,
        sharedCalendarEventId: mirrorEventId,
        // Gated on the provider, not just on the URL being present: this
        // column is Meet-only by design, and a Zoom URL landing in it would
        // make reminders quote a link that never gets its live `?pwd=`.
        meetJoinUrl:
          booked?.videoProvider === "google_meet" && typeof booked.videoJoinUrl === "string"
            ? booked.videoJoinUrl
            : null
      });
    } else {
      await releaseBookingDedupe(claim.id);
    }
  }
  const finalResult = await withStartLocal(result);

  // Waitlist resolution (best-effort by module contract): a fresh CONFIRMED
  // booking for a waitlisted attendee either fulfills their entry (they got
  // an earlier time) or re-points it at what they now hold. Dedupe retries
  // returned above; link-mode results carry no eventId and are skipped.
  if (finalResult.ok) {
    const booked = (finalResult.data ?? {}) as Record<string, unknown>;
    if (typeof booked.eventId === "string" && booked.eventId.length > 0) {
      await resolveWaitlistAfterBooking(
        businessId,
        { phones: attendeePhone ? [attendeePhone] : [], email: args.attendeeEmail ?? null },
        new Date(args.startIso).toISOString()
      );
    }
  }

  // Unassigned-booking owner alert (Truly, Jul 21 2026): a customer-facing
  // AI surface just confirmed a REAL appointment, if no teammate owns this
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
        await fireGoalEvent(businessId, bookedLeadIdentity(args, fallbackPhone), {
          kind: "appointment_booked"
        });
        await fireLifecycleStage(businessId, args.attendeePhone ?? fallbackPhone, "booked", {
          dedupeSuffix: String(vagaroEventId)
        });
      }
      return vagaroResult;
    }

    if (conn.provider === "acuity") {
      // Real booking on the merchant's Acuity book (direct API, no Nango).
      const timezone = await resolveToolTimezone(businessId, args.timezone);
      const acuityResult = await bookAcuityAppointment(
        businessId,
        { ...args, timezone },
        fallbackPhone
      );
      // Same confirmed-event rule as every other real-booking provider: only
      // a response carrying an appointment id counts as booked for goals.
      const acuityEventId = (acuityResult.data as { eventId?: unknown } | undefined)?.eventId;
      if (acuityResult.ok && acuityEventId) {
        await fireGoalEvent(businessId, bookedLeadIdentity(args, fallbackPhone), {
          kind: "appointment_booked"
        });
        await fireLifecycleStage(businessId, args.attendeePhone ?? fallbackPhone, "booked", {
          dedupeSuffix: String(acuityEventId)
        });
      }
      return acuityResult;
    }

    if (conn.provider === "calendly") {
      // Calendly cannot create the booking, hand back a single-use link.
      return createCalendlyBookingLink(businessId, conn, {
        startIso: args.startIso,
        endIso: args.endIso
      });
    }

    // Zoom decorator for the REAL-booking calendar providers below (CalDAV,
    // Google, Microsoft): with a connected Zoom account, first-party
    // zoom_connections, or a legacy Nango link, the appointment gets a
    // scheduled Zoom meeting whose join link rides the event body and the
    // tool result (so the agent texts/emails it in the confirmation).
    // Best-effort by contract: null means "no video link", never a failed
    // booking. Vagaro and Acuity (in-person services) and Calendly
    // (link-mode, no confirmed event) stay Zoom-free.
    const zoomMeeting = await createZoomMeetingForBooking(businessId, {
      topic: args.summary,
      startIso: args.startIso,
      endIso: args.endIso,
      ...(args.notes ? { agenda: args.notes } : {})
    });
    orphanZoomMeetingId = zoomMeeting?.meetingId ?? null;
    const zoomLine = zoomMeeting ? `Video call (Zoom): ${zoomMeeting.joinUrl}` : "";

    // Google Meet is the FALLBACK video option, never a second link. It is
    // considered only when Zoom produced nothing, which is the whole of the
    // precedence rule: Zoom already ran just above, so "Zoom wins" falls out
    // of the ordering with no resolver to keep in step.
    //
    // Google only, because a Meet link is a property of a Google Calendar
    // event (see src/lib/google/meet.ts). Microsoft and CalDAV have no event
    // that could carry one, and reaching them would mean the Meet REST API
    // and a new sensitive OAuth scope, which src/lib/google/workspace-scopes.ts
    // documents as a fresh verification event rather than a code change.
    const wantsMeet =
      zoomMeeting === null &&
      conn.provider === "google" &&
      (await isGoogleMeetEnabled(businessId));

    // Whichever provider ends up supplying the link. Zoom's is known now;
    // Meet's cannot be, because it does not exist until the Google insert
    // responds, so the Google branch fills these in.
    let videoJoinUrl: string | null = zoomMeeting?.joinUrl ?? null;
    let videoProvider: "zoom" | "google_meet" | null = zoomMeeting ? "zoom" : null;
    // Read at each return site rather than captured once, for that reason.
    const videoData = (): Record<string, unknown> => ({
      // The Zoom lifecycle handle. Never carries a Meet value: a Meet
      // booking has nothing to move or delete, and every consumer of this
      // field calls the Zoom API with it.
      ...(zoomMeeting ? { zoomMeetingId: zoomMeeting.meetingId } : {}),
      ...(videoJoinUrl && videoProvider ? { videoJoinUrl, videoProvider } : {})
    });

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
        await fireGoalEvent(businessId, bookedLeadIdentity(args, fallbackPhone), {
          kind: "appointment_booked"
        });
        await fireLifecycleStage(businessId, args.attendeePhone ?? fallbackPhone, "booked", {
          dedupeSuffix: String(caldavEventId)
        });
        return {
          ...caldavResult,
          // CalDAV events carry the attendee in the description only, the
          // server emails nobody. Explicit null so the model never promises
          // an invite on this provider.
          data: {
            ...(caldavResult.data as Record<string, unknown>),
            inviteEmail: null,
            ...videoData()
          }
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
    // plus the zone name, an offset-carrying string sent raw is exactly
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
      const googleLink = {
        connectionId: conn.connectionId,
        providerConfigKey: conn.providerConfigKey
      };
      const googleEvent = {
        summary: args.summary,
        description,
        start: { dateTime: startInstant.toISOString(), timeZone: eventTimezone },
        end: { dateTime: endInstant.toISOString(), timeZone: eventTimezone },
        attendees: args.attendeeEmail
          ? [{ email: args.attendeeEmail, displayName: args.attendeeName }]
          : undefined
      };

      let res: Awaited<ReturnType<typeof workspaceProxyForBusiness>>;
      if (wantsMeet) {
        // Asking for the conference is NOT a separate best-effort call: it
        // rides the very request that creates the appointment. Google
        // answers 400 ("Invalid conference type value") when the target
        // calendar does not allow hangoutsMeet, and secondary calendars,
        // which is what ensureSharedCalendar creates, do not reliably
        // advertise it, least of all on a personal @gmail account. Sent
        // naively, a tenant whose calendar refuses Meet would lose the
        // BOOKING, not just the video link.
        //
        // So this one goes through the status-returning proxy. ONLY a 4xx is
        // safe to retry: a client refusal means Google created nothing, so
        // the insert can be repeated once with no conference at all.
        //
        // A 5xx is NOT safe and is deliberately not retried. Google may have
        // created the event and then failed to say so, and a blind second
        // insert would book the slot twice. It is treated exactly like a
        // failure with no status at all (timeout, socket reset, which
        // `workspaceProxyStatusForBusiness` re-throws on its own): the
        // booking reports failure rather than risking a duplicate.
        const meetRes = await workspaceProxyStatusForBusiness(businessId, googleLink, {
          endpoint: googleCalendarPath,
          method: "POST",
          params: { conferenceDataVersion: MEET_CONFERENCE_DATA_VERSION },
          data: { ...googleEvent, conferenceData: buildMeetConferenceRequest(randomUUID()) }
        });
        if (meetRes && meetRes.status >= 500) {
          throw new Error(`google event insert failed (${meetRes.status})`);
        }
        if (meetRes && meetRes.status >= 400) {
          logger.warn("google meet conference refused; rebooking without it", {
            businessId,
            status: meetRes.status
          });
          res = await workspaceProxyForBusiness(businessId, googleLink, {
            endpoint: googleCalendarPath,
            method: "POST",
            data: googleEvent
          });
        } else {
          res = meetRes;
        }
      } else {
        res = await workspaceProxyForBusiness(businessId, googleLink, {
          endpoint: googleCalendarPath,
          method: "POST",
          data: googleEvent
        });
      }

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

      // The conference may still be provisioning, in which case the insert
      // response carries no link yet. One re-read, never a loop: the
      // appointment is already booked and the only thing still at stake is
      // whether the confirmation can quote a link, which is not worth making
      // a caller (a live phone call, often) wait on a poll.
      const createdId = eventId;
      if (wantsMeet && createdId) {
        videoJoinUrl = await resolveMeetJoinUrl(res.data, async () => {
          const reread = await workspaceProxyForBusiness(businessId, googleLink, {
            endpoint: `${googleCalendarPath}/${encodeURIComponent(createdId)}`,
            method: "GET",
            params: { conferenceDataVersion: MEET_CONFERENCE_DATA_VERSION }
          });
          return reread?.data ?? null;
        });
        if (videoJoinUrl) {
          videoProvider = "google_meet";
        } else {
          logger.warn("google meet link unavailable; booking proceeds without", {
            businessId,
            eventId: createdId
          });
        }
      }
    } else {
      const res = await workspaceProxyForBusiness(
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
    // between here and there). Only a CONFIRMED create fires it, a provider
    // response without an event id is not a booking. Best-effort inside
    // fireGoalEvent; the Calendly path above is exempt, a scheduling LINK is
    // not a booking.
    if (eventId) {
      await fireGoalEvent(businessId, bookedLeadIdentity(args, fallbackPhone), {
        kind: "appointment_booked"
      });
      await fireLifecycleStage(businessId, args.attendeePhone ?? fallbackPhone, "booked", {
        dedupeSuffix: String(eventId)
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
        ...(eventId ? videoData() : {})
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
