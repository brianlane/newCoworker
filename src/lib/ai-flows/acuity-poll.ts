/**
 * Acuity candidate-event fetcher for the AiFlow calendar-trigger poller.
 *
 * Acuity tenants had NO working calendar triggers: the poller's fetchers
 * speak Google/Graph/Calendly/Vagaro only, so appointment-driven flows
 * ("text the customer 2 hours before their appointment", "follow up after
 * the visit") were impossible for a merchant whose whole book lives on
 * Acuity. This module lists the merchant's appointments over the poller's
 * mode windows and normalizes them into the same `CalendarEventInput` shape
 * the other fetchers produce, so due-checks, conditions, dedupe keys and
 * enqueueing work unchanged.
 *
 * Two differences from the Vagaro fetcher matter:
 *
 *   - THE LISTING IS DATE-GRANULAR. Acuity's `minDate`/`maxDate` take local
 *     dates, not instants, so every window boundary is converted with
 *     `acuityLocalDate` in the connection's timezone. Windows therefore
 *     round OUTWARD to whole local days; the poller's own due-filter does
 *     the precise instant work, so a slightly wide listing costs a few extra
 *     rows, never a wrong fire.
 *
 *   - THERE IS NO LAST-MODIFIED FIELD. `event_canceled` gates on when a
 *     change happened, and Acuity does not say. We synthesize it from our
 *     own observation shadow (`@/lib/db/acuity-appointment-state`), which is
 *     also what gives us reschedule detection Acuity's API cannot express.
 *     The webhook receiver writes the same shadow, so both paths agree.
 */

import {
  acuityLocalDate,
  listAcuityAppointments,
  type AcuityAppointmentItem
} from "@/lib/acuity/client";
import {
  getActiveAcuityConnection,
  type AcuityConnectionRow
} from "@/lib/db/acuity-connections";
import {
  recordAcuityObservations,
  type AcuityObservation
} from "@/lib/db/acuity-appointment-state";
import type { CalendarEventInput } from "@/lib/ai-flows/trigger-eval";
import { logger } from "@/lib/logger";

/** A full page at this size flags the poll as overflowed (poller parity). */
export const ACUITY_POLL_MAX_EVENTS = 100;

/** event_created scans this many days of UPCOMING appointments. */
export const ACUITY_CREATED_SCAN_DAYS = 30;

/**
 * event_created also reaches this far BACK: a booking made moments ago for a
 * start already in the past (a walk-in entered at the front desk) would
 * otherwise never enter the candidate set.
 */
export const ACUITY_CREATED_SCAN_BACK_DAYS = 1;

/**
 * end-mode listing assumes no appointment runs longer than this (the listing
 * filters on START, so the window must reach back far enough that a long
 * appointment whose END is only now due is still listed).
 */
export const ACUITY_END_MAX_EVENT_MINUTES = 6 * 60;

/** event_canceled scan bounds, by appointment start. */
export const ACUITY_CANCELED_SCAN_BACK_DAYS = 1;
export const ACUITY_CANCELED_SCAN_FORWARD_DAYS = 90;

/**
 * One normalized Acuity appointment → the poller's event shape. The
 * customer's identity lands in the description as "key: value" lines so
 * trigger conditions and extract_text can read them (Vagaro/Calendly
 * parity). Shared with the webhook receiver so the poll and the real-time
 * path produce byte-identical events, and therefore identical dedupe keys.
 *
 * `updatedIso` is supplied by the caller from the observation shadow, not
 * read off the payload: Acuity has no last-modified field.
 */
export function acuityAppointmentToCalendarEvent(
  item: AcuityAppointmentItem,
  updatedIso?: string | null
): CalendarEventInput {
  const lines: string[] = [];
  if (item.customerName) lines.push(`customer name: ${item.customerName}`);
  if (item.customerPhone) lines.push(`customer phone: ${item.customerPhone}`);
  if (item.customerEmail) lines.push(`customer email: ${item.customerEmail}`);
  if (item.appointmentTypeName) lines.push(`service: ${item.appointmentTypeName}`);
  if (item.calendarName) lines.push(`staff: ${item.calendarName}`);
  const attendee = item.customerName
    ? item.customerEmail
      ? `${item.customerName} <${item.customerEmail}>`
      : item.customerName
    : item.customerEmail;
  return {
    id: item.id,
    title: item.appointmentTypeName ?? "Appointment",
    ...(lines.length > 0 ? { description: lines.join("\n") } : {}),
    ...(attendee ? { attendees: [attendee] } : {}),
    startIso: item.startIso,
    ...(item.endIso ? { endIso: item.endIso } : {}),
    ...(item.createdIso ? { createdIso: item.createdIso } : {}),
    ...(updatedIso ? { updatedIso } : {}),
    cancelled: item.canceled,
    // Acuity has no shared-calendar concept, everything is "primary".
    calendar: "primary"
  };
}

export type AcuityPollWindows = {
  /** Any event_created flow present (scan upcoming, lookback-gated later). */
  createdScan: boolean;
  /** Largest event_start lead + buffer, or null when no start-mode flow. */
  startHorizonMinutes: number | null;
  /** Largest event_end follow + lookback, or null when no end-mode flow. */
  endBackMinutes: number | null;
  /** Any event_canceled flow present. */
  canceledScan: boolean;
};

export type AcuityFetch = { events: CalendarEventInput[]; overflowed: boolean };

export type AcuityPollDeps = {
  getConnection?: typeof getActiveAcuityConnection;
  list?: typeof listAcuityAppointments;
  recordObservations?: typeof recordAcuityObservations;
};

/**
 * List, normalize and due-filter this business's Acuity candidate events for
 * one poll tick.
 *
 * Windows run SEQUENTIALLY, never concurrently: Acuity's rate limit is per
 * egress IP and shared across the fleet, so a tenant fanning out four
 * listings at once is exactly the burst the client's budget exists to stop.
 *
 * Per-window isolation matches the other fetchers: one window failing must
 * not drop what the others collected, and only a total failure propagates.
 */
export async function fetchAcuityCandidateEvents(
  args: {
    businessId: string;
    nowMs: number;
    windows: AcuityPollWindows;
    dueFilter: (ev: CalendarEventInput) => boolean;
  },
  deps: AcuityPollDeps = {}
): Promise<AcuityFetch> {
  const getConnection = deps.getConnection ?? getActiveAcuityConnection;
  const list = deps.list ?? listAcuityAppointments;
  const recordObservations = deps.recordObservations ?? recordAcuityObservations;
  const { businessId, nowMs, windows } = args;

  const conn: AcuityConnectionRow | null = await getConnection(businessId);
  if (!conn) throw new Error("calendar_not_connected");

  const timezone = conn.default_calendar_timezone ?? "UTC";
  const collected: AcuityAppointmentItem[] = [];
  const indexById = new Map<string, number>();
  let overflowed = false;
  const dayMs = 86_400_000;
  const minuteMs = 60_000;
  const localDate = (ms: number): string => acuityLocalDate(new Date(ms), timezone);

  const push = (items: AcuityAppointmentItem[]): void => {
    overflowed ||= items.length >= ACUITY_POLL_MAX_EVENTS;
    for (const item of items) {
      const existingIdx = indexById.get(item.id);
      if (existingIdx !== undefined) {
        // The canceled window runs LAST and is the only listing that carries
        // cancellations, so a canceled row must replace the stale standing
        // one an earlier window collected. Without this, event_canceled
        // never becomes due from the poll and the other modes keep treating
        // the appointment as live (the Vagaro lesson, Bugbot on PR #810).
        if (item.canceled && !collected[existingIdx].canceled) {
          collected[existingIdx] = item;
        }
        continue;
      }
      indexById.set(item.id, collected.length);
      collected.push(item);
    }
  };

  let windowFailure: unknown = null;
  const listSafely = async (
    label: string,
    listArgs: { minDate: string; maxDate: string; canceled?: boolean }
  ): Promise<void> => {
    try {
      push(await list(conn, { ...listArgs, max: ACUITY_POLL_MAX_EVENTS }));
    } catch (err) {
      windowFailure = err;
      logger.warn("acuity poll: window listing failed", {
        businessId,
        window: label,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  if (windows.createdScan) {
    await listSafely("created", {
      minDate: localDate(nowMs - ACUITY_CREATED_SCAN_BACK_DAYS * dayMs),
      maxDate: localDate(nowMs + ACUITY_CREATED_SCAN_DAYS * dayMs)
    });
  }
  if (windows.startHorizonMinutes !== null) {
    await listSafely("start", {
      minDate: localDate(nowMs),
      maxDate: localDate(nowMs + windows.startHorizonMinutes * minuteMs)
    });
  }
  if (windows.endBackMinutes !== null) {
    await listSafely("end", {
      minDate: localDate(
        nowMs - (windows.endBackMinutes + ACUITY_END_MAX_EVENT_MINUTES) * minuteMs
      ),
      maxDate: localDate(nowMs)
    });
  }
  if (windows.canceledScan) {
    await listSafely("canceled", {
      minDate: localDate(nowMs - ACUITY_CANCELED_SCAN_BACK_DAYS * dayMs),
      maxDate: localDate(nowMs + ACUITY_CANCELED_SCAN_FORWARD_DAYS * dayMs),
      canceled: true
    });
  }

  if (collected.length === 0) {
    if (windowFailure !== null) {
      throw windowFailure instanceof Error ? windowFailure : new Error(String(windowFailure));
    }
    return { events: [], overflowed };
  }

  // Diff against our observation shadow to learn WHEN each appointment last
  // changed, Acuity itself will not tell us.
  const observations: AcuityObservation[] = collected.map((item) => ({
    appointmentId: item.id,
    startIso: item.startIso,
    canceled: item.canceled
  }));
  const transitions = await recordObservations(
    businessId,
    observations,
    new Date(nowMs).toISOString()
  );
  const updatedById = new Map(transitions.map((t) => [t.appointmentId, t.updatedIso]));

  const events = collected.map((item) =>
    acuityAppointmentToCalendarEvent(item, updatedById.get(item.id) ?? null)
  );
  return { events: events.filter(args.dueFilter), overflowed };
}
