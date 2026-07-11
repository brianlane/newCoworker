/**
 * CalDAV provider cores for the calendar tools.
 *
 * Unlike Calendly (link-only), a CalDAV connection supports REAL free/busy
 * search and REAL event creation on the owner's calendar (iCloud, Nextcloud,
 * generic servers). The two cores here plug into handlers.ts the same way
 * the Vagaro cores do:
 *
 *   - getCaldavBusyBlocks → busy blocks for the window; handlers.ts feeds
 *     them through its shared computeFreeSlots walk so slot alignment
 *     (:00/:30 preference) matches every other provider.
 *   - bookCaldavAppointment → PUT the event and return the standard
 *     {eventId, htmlLink, provider, calendar} success payload.
 *
 * The event calendar is discovered once at connect time and cached on the
 * row (`calendar_url`); when the cache is empty (legacy row, cleared by an
 * error) we re-discover and persist best-effort.
 */
import {
  getActiveCaldavConnection,
  upsertCaldavConnection,
  type CaldavConnectionRow
} from "@/lib/db/caldav-connections";
import {
  CaldavApiError,
  createCaldavEvent,
  discoverEventCalendars,
  fetchCaldavBusy,
  pickPreferredCalendar,
  type BusyBlock
} from "@/lib/caldav/client";
import type { CalendarToolResult } from "@/lib/calendar-tools/handlers";
import { logger } from "@/lib/logger";

type CaldavBusyOutcome =
  | { ok: true; busy: BusyBlock[] }
  | { ok: false; result: CalendarToolResult };

function credentialsOf(row: CaldavConnectionRow) {
  return { serverUrl: row.server_url, username: row.username, password: row.password };
}

/** Map transport errors to the standard tool-result vocabulary. */
function failureResult(err: unknown, fallbackDetail: string): CalendarToolResult {
  if (err instanceof CaldavApiError && (err.code === "auth_failed" || err.code === "blocked_url")) {
    // Revoked app-specific password / unusable stored URL: same semantics
    // as a stale OAuth link.
    return { ok: false, detail: "calendar_not_connected" };
  }
  logger.warn("calendar-tools/caldav failed", {
    error: err instanceof Error ? err.message : String(err)
  });
  return { ok: false, detail: fallbackDetail };
}

/**
 * The connection's event calendar (URL + display name), using the row cache
 * when present and re-running discovery (persisted best-effort) when it is
 * not — so callers see the discovered name even on the request that had to
 * re-discover.
 */
async function resolveCalendar(
  row: CaldavConnectionRow
): Promise<{ url: string; name: string | null } | null> {
  if (row.calendar_url) return { url: row.calendar_url, name: row.calendar_name };
  const calendars = await discoverEventCalendars(credentialsOf(row));
  const picked = pickPreferredCalendar(calendars);
  if (!picked) return null;
  try {
    await upsertCaldavConnection({
      businessId: row.business_id,
      calendarUrl: picked.url,
      calendarName: picked.name
    });
  } catch (err) {
    // Cache refresh only — the discovery result still serves this call.
    logger.warn("calendar-tools/caldav: calendar cache persist failed", {
      businessId: row.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return { url: picked.url, name: picked.name };
}

/** Busy blocks for handlers.ts' shared free-slot walk. */
export async function getCaldavBusyBlocks(
  businessId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<CaldavBusyOutcome> {
  try {
    const row = await getActiveCaldavConnection(businessId);
    if (!row) return { ok: false, result: { ok: false, detail: "calendar_not_connected" } };
    const calendar = await resolveCalendar(row);
    if (!calendar) {
      return { ok: false, result: { ok: false, detail: "calendar_not_connected" } };
    }
    const busy = await fetchCaldavBusy(credentialsOf(row), calendar.url, windowStart, windowEnd);
    return { ok: true, busy };
  } catch (err) {
    return { ok: false, result: failureResult(err, "calendar_lookup_failed") };
  }
}

export type CaldavBookArgs = {
  startIso: string;
  endIso: string;
  summary: string;
  description: string;
};

/**
 * `calendar_book_appointment` core for CalDAV connections. Returns the
 * standard success payload; handlers.ts fires the appointment_booked goal
 * when an eventId is present (same confirmed-create rule as every other
 * real-booking provider).
 */
export async function bookCaldavAppointment(
  businessId: string,
  args: CaldavBookArgs
): Promise<CalendarToolResult> {
  try {
    const row = await getActiveCaldavConnection(businessId);
    if (!row) return { ok: false, detail: "calendar_not_connected" };
    const calendar = await resolveCalendar(row);
    if (!calendar) return { ok: false, detail: "calendar_not_connected" };

    const uid = `newcoworker-${crypto.randomUUID()}`;
    const { eventUid } = await createCaldavEvent(credentialsOf(row), calendar.url, {
      uid,
      summary: args.summary,
      description: args.description,
      startIso: args.startIso,
      endIso: args.endIso
    });
    return {
      ok: true,
      data: {
        eventId: eventUid,
        htmlLink: null,
        provider: "caldav",
        // Resolved (not raw-row) name so a booking that had to re-discover
        // the calendar still reports the real display name.
        calendar: calendar.name ?? "caldav"
      }
    };
  } catch (err) {
    return failureResult(err, "calendar_book_failed");
  }
}
