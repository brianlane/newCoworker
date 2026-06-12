import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getBusinessTimezone } from "@/lib/db/businesses";
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
};

type Slot = { startIso: string; endIso: string };

/**
 * Timezone the event/slot payloads should use: the model's explicit choice
 * first, then the business timezone, then UTC. Looked up per call (single
 * indexed read) and never fatal — a lookup error degrades to UTC, exactly
 * the pre-timezone behavior.
 */
async function resolveToolTimezone(
  businessId: string,
  explicit: string | undefined
): Promise<string> {
  if (explicit && explicit.trim().length > 0) return explicit;
  try {
    return (await getBusinessTimezone(businessId)) ?? "UTC";
  } catch {
    return "UTC";
  }
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

export function computeFreeSlots(
  windowStart: Date,
  windowEnd: Date,
  busy: Array<{ start: Date; end: Date }>,
  durationMs: number,
  maxSlots = 3
): Slot[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const slots: Slot[] = [];
  let cursor = windowStart;
  for (const block of sorted) {
    if (block.start.getTime() >= windowEnd.getTime()) break;
    if (block.end.getTime() <= cursor.getTime()) continue;
    if (block.start.getTime() - cursor.getTime() >= durationMs) {
      slots.push({
        startIso: cursor.toISOString(),
        endIso: new Date(cursor.getTime() + durationMs).toISOString()
      });
      if (slots.length >= maxSlots) return slots;
    }
    // Past the `continue` guard above, block.end > cursor always holds.
    cursor = block.end;
  }
  if (windowEnd.getTime() - cursor.getTime() >= durationMs && slots.length < maxSlots) {
    slots.push({
      startIso: cursor.toISOString(),
      endIso: new Date(cursor.getTime() + durationMs).toISOString()
    });
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

    let busy: Array<{ start: Date; end: Date }> = [];

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/calendar/v3/freeBusy",
          method: "POST",
          data: {
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            items: [{ id: "primary" }]
          }
        }
      );
      if (!res) return { ok: false, detail: "calendar_not_connected" };
      const data = res.data as FreeBusyBody;
      const blocks = data?.calendars?.primary?.busy ?? [];
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
    }

    const slots = computeFreeSlots(windowStart, windowEnd, busy, durationMs);
    // Echo the resolved timezone so the model presents the ISO slots in
    // business-local terms instead of raw UTC.
    const timezone = await resolveToolTimezone(businessId, args.timezone);
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
export async function bookCalendarAppointment(
  businessId: string,
  args: BookAppointmentArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  if (new Date(args.endIso).getTime() <= new Date(args.startIso).getTime()) {
    return { ok: false, detail: "invalid_window" };
  }

  try {
    const conn = await resolveCalendarConnection(businessId);
    if (!conn) {
      return { ok: false, detail: "calendar_not_connected" };
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

    // Model's explicit timezone → business timezone → UTC. Means a naive
    // local "2026-06-13T14:00:00" books 2pm business-local without the
    // model reasoning about offsets.
    const eventTimezone = await resolveToolTimezone(businessId, args.timezone);

    if (conn.provider === "google") {
      const res = await nangoProxyForBusiness(
        businessId,
        { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey },
        {
          endpoint: "/calendar/v3/calendars/primary/events",
          method: "POST",
          data: {
            summary: args.summary,
            description,
            start: { dateTime: args.startIso, timeZone: eventTimezone },
            end: { dateTime: args.endIso, timeZone: eventTimezone },
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
          endpoint: "/v1.0/me/events",
          method: "POST",
          data: {
            subject: args.summary,
            body: { contentType: "Text", content: description },
            start: { dateTime: args.startIso, timeZone: eventTimezone },
            end: { dateTime: args.endIso, timeZone: eventTimezone },
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

    return {
      ok: true,
      data: { eventId, htmlLink, provider: conn.provider }
    };
  } catch (err) {
    logger.warn("calendar-tools/book failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "calendar_book_failed" };
  }
}
