/**
 * Vagaro candidate-event fetcher for the AiFlow calendar-trigger poller.
 *
 * Vagaro tenants had NO working calendar triggers: the poller's fetchers
 * speak Google/Graph/Calendly only, so appointment-driven flows —
 * "text the customer 2 hours before their appointment", "follow up after
 * the visit" — were impossible for a merchant whose whole book lives on
 * Vagaro. This module lists the merchant's appointments over the poller's
 * mode windows (via the direct Vagaro API client) and normalizes them into
 * the same `CalendarEventInput` shape the other fetchers produce, so
 * due-checks, conditions, dedupe keys, and enqueueing work unchanged.
 *
 * Notable differences from the other providers:
 *   - No "shared" calendar; every appointment lands on the "primary"
 *     source, and shared-only flows simply see no Vagaro events (Calendly
 *     parity).
 *   - The appointments listing already carries the customer's name / phone /
 *     email, so there is no per-event enrichment call — those fields land in
 *     the event description (trigger conditions and
 *     `{{trigger.windowText}}` → extract_text see them, invitee-context
 *     parity).
 *   - The listing filters on START date only; `event_created` is gated in
 *     JS on the item's creation timestamp. A listing that omits creation
 *     timestamps simply never fires created mode from the poll — the
 *     Vagaro webhook receiver fires it in real time either way
 *     (src/lib/vagaro/webhook.ts), sharing the same `cal:` dedupe keys.
 *   - `event_canceled` needs a status-filtered listing; if the merchant's
 *     API rejects the status parameter the canceled window is skipped
 *     (per-window isolation) and cancellations ride the webhook only.
 */

import {
  listVagaroAppointments,
  type VagaroAppointmentItem
} from "@/lib/vagaro/client";
import { getActiveVagaroConnection, type VagaroConnectionRow } from "@/lib/db/vagaro-connections";
import type { CalendarEventInput } from "@/lib/ai-flows/trigger-eval";
import { logger } from "@/lib/logger";

/** A full page at this size flags the poll as overflowed (poller parity). */
export const VAGARO_POLL_MAX_EVENTS = 100;

/**
 * event_created scans this many days of UPCOMING appointments (the listing
 * cannot filter by creation time server-side; `eventCreatedDue` narrows to
 * the real lookback). Calendly-parity values — fresh bookings
 * overwhelmingly start within days.
 */
export const VAGARO_CREATED_SCAN_DAYS = 30;

/**
 * event_created also reaches this far BACK: a booking made moments ago for
 * a start time already in the past (front desk booking in the walk-in) would
 * otherwise never enter the candidate set.
 */
export const VAGARO_CREATED_SCAN_BACK_DAYS = 1;

/**
 * end-mode listing assumes no appointment runs longer than this (the
 * listing filters on START time, so the window must reach back far enough
 * to catch a long appointment whose END is only now due).
 */
export const VAGARO_END_MAX_EVENT_MINUTES = 6 * 60;

/**
 * event_canceled scan bounds: canceled appointments whose start falls in
 * [-back, +forward]; `eventCanceledDue` gates on the cancellation moment
 * (the item's last-modified timestamp).
 */
export const VAGARO_CANCELED_SCAN_BACK_DAYS = 1;
export const VAGARO_CANCELED_SCAN_FORWARD_DAYS = 90;

/** Status value sent for the canceled-window listing. */
export const VAGARO_CANCELED_LIST_STATUS = "cancelled";

/**
 * One normalized Vagaro appointment → the poller's event shape. The
 * customer's identity lands in the description as "key: value" lines so
 * trigger conditions and extract_text can read them (Calendly's invitee
 * context parity). Shared with the webhook receiver so the poll and the
 * real-time path produce byte-identical events (and dedupe keys).
 */
export function vagaroAppointmentToCalendarEvent(
  item: VagaroAppointmentItem
): CalendarEventInput {
  const lines: string[] = [];
  if (item.customerName) lines.push(`customer name: ${item.customerName}`);
  if (item.customerPhone) lines.push(`customer phone: ${item.customerPhone}`);
  if (item.customerEmail) lines.push(`customer email: ${item.customerEmail}`);
  if (item.serviceName) lines.push(`service: ${item.serviceName}`);
  const attendee = item.customerName
    ? item.customerEmail
      ? `${item.customerName} <${item.customerEmail}>`
      : item.customerName
    : item.customerEmail;
  return {
    id: item.id,
    title: item.serviceName ?? "Appointment",
    ...(lines.length > 0 ? { description: lines.join("\n") } : {}),
    ...(attendee ? { attendees: [attendee] } : {}),
    startIso: item.startIso,
    ...(item.endIso ? { endIso: item.endIso } : {}),
    ...(item.createdIso ? { createdIso: item.createdIso } : {}),
    ...(item.updatedIso ? { updatedIso: item.updatedIso } : {}),
    cancelled: item.cancelled,
    // Vagaro has no shared-calendar concept — everything is "primary".
    calendar: "primary"
  };
}

export type VagaroPollWindows = {
  /** Any event_created flow present (scan upcoming, lookback-gated later). */
  createdScan: boolean;
  /** Largest event_start lead + buffer, or null when no start-mode flow. */
  startHorizonMinutes: number | null;
  /** Largest event_end follow + lookback, or null when no end-mode flow. */
  endBackMinutes: number | null;
  /** Any event_canceled flow present. */
  canceledScan: boolean;
};

export type VagaroFetch = { events: CalendarEventInput[]; overflowed: boolean };

export type VagaroPollDeps = {
  /** Injectable connection lookup (tests). */
  getConnection?: typeof getActiveVagaroConnection;
  /** Injectable listing transport (tests). */
  list?: typeof listVagaroAppointments;
};

/**
 * List + normalize + due-filter this business's Vagaro candidate events for
 * one poll tick. Throws `calendar_not_connected` when the connection row is
 * gone (resolved moments earlier by the caller — a vanished row is a
 * disconnect); listing failures follow the per-window isolation rule: one
 * window failing must not drop the events other windows collected, and only
 * when EVERY window failed with nothing collected does the failure
 * propagate.
 */
export async function fetchVagaroCandidateEvents(
  args: {
    businessId: string;
    nowMs: number;
    windows: VagaroPollWindows;
    dueFilter: (ev: CalendarEventInput) => boolean;
  },
  deps: VagaroPollDeps = {}
): Promise<VagaroFetch> {
  const getConnection = deps.getConnection ?? getActiveVagaroConnection;
  const list = deps.list ?? listVagaroAppointments;
  const { businessId, nowMs, windows } = args;

  const conn: VagaroConnectionRow | null = await getConnection(businessId);
  if (!conn) throw new Error("calendar_not_connected");

  const collected: CalendarEventInput[] = [];
  const indexById = new Map<string, number>();
  let overflowed = false;
  const iso = (ms: number) => new Date(ms).toISOString();
  const minuteMs = 60_000;
  const dayMs = 24 * 60 * minuteMs;

  const push = (items: VagaroAppointmentItem[]): void => {
    overflowed ||= items.length >= VAGARO_POLL_MAX_EVENTS;
    for (const item of items) {
      const ev = vagaroAppointmentToCalendarEvent(item);
      const existingIdx = indexById.get(ev.id);
      if (existingIdx !== undefined) {
        // The canceled window runs LAST and is the only listing that carries
        // cancellations — a canceled version must replace the stale
        // non-canceled row an earlier window already collected, or
        // event_canceled never becomes due from the poll (Bugbot on PR #810)
        // and the other modes keep treating the appointment as standing.
        if (ev.cancelled && !collected[existingIdx].cancelled) {
          collected[existingIdx] = ev;
        }
        continue;
      }
      indexById.set(ev.id, collected.length);
      collected.push(ev);
    }
  };

  // Per-window isolation (fetcher parity): log and keep going; the dedupe
  // keys make next tick's retry benign. Propagate only a total failure.
  let windowFailure: unknown = null;
  const listSafely = async (
    label: string,
    listArgs: { startIso: string; endIso: string; status?: string }
  ): Promise<void> => {
    try {
      push(await list(conn, listArgs));
    } catch (err) {
      windowFailure = err;
      logger.warn("vagaro poll: window listing failed", {
        businessId,
        window: label,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  if (windows.createdScan) {
    await listSafely("created", {
      startIso: iso(nowMs - VAGARO_CREATED_SCAN_BACK_DAYS * dayMs),
      endIso: iso(nowMs + VAGARO_CREATED_SCAN_DAYS * dayMs)
    });
  }
  if (windows.startHorizonMinutes !== null) {
    await listSafely("start", {
      startIso: iso(nowMs),
      endIso: iso(nowMs + windows.startHorizonMinutes * minuteMs)
    });
  }
  if (windows.endBackMinutes !== null) {
    // The listing filters on START time; reach back far enough that a long
    // appointment whose END is only now due is still listed.
    await listSafely("end", {
      startIso: iso(nowMs - (windows.endBackMinutes + VAGARO_END_MAX_EVENT_MINUTES) * minuteMs),
      endIso: iso(nowMs)
    });
  }
  if (windows.canceledScan) {
    await listSafely("canceled", {
      startIso: iso(nowMs - VAGARO_CANCELED_SCAN_BACK_DAYS * dayMs),
      endIso: iso(nowMs + VAGARO_CANCELED_SCAN_FORWARD_DAYS * dayMs),
      status: VAGARO_CANCELED_LIST_STATUS
    });
  }
  if (collected.length === 0 && windowFailure !== null) {
    throw windowFailure instanceof Error ? windowFailure : new Error(String(windowFailure));
  }

  return { events: collected.filter(args.dueFilter), overflowed };
}
