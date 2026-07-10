/**
 * Calendly provider cores for the calendar tools.
 *
 * Calendly's API is deliberately narrower than Google/Microsoft: it can list
 * an event type's bookable times, but it cannot CREATE a booking on the
 * invitee's behalf — invitees always confirm through a Calendly page. So:
 *
 *   - findCalendlySlots        → GET /event_type_available_times, mapped to
 *     the same `{slots, timezone}` shape the other providers return.
 *   - createCalendlyBookingLink → POST /scheduling_links with
 *     `max_event_count: 1`; the result carries `bookingLink` and the distinct
 *     detail `booking_link_created` so the model knows the appointment is NOT
 *     booked yet — it must send the link to the customer to finish.
 *
 * Both pick the owner's active event type whose duration is closest to the
 * requested duration (ties go to the earlier listing). All HTTP goes through
 * the Nango proxy, which re-verifies the connection belongs to the business.
 */

import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import type { ResolvedVoiceConnection } from "@/lib/voice-tools/connections";
import type { CalendarToolResult } from "@/lib/calendar-tools/handlers";

/** Calendly rejects availability queries spanning more than 7 days. */
export const CALENDLY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Calendly rejects start times in the past; nudge "now" forward a minute. */
export const CALENDLY_MIN_LEAD_MS = 60 * 1000;
/** Match the other providers: offer at most 3 candidate slots. */
const MAX_SLOTS = 3;

export type CalendlyEventType = {
  uri: string;
  name: string;
  /** Minutes. */
  duration: number;
  schedulingUrl: string | null;
};

export type CalendlyFindSlotsArgs = {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  purpose?: string;
  /** Already resolved (model choice → business tz → UTC) by the caller. */
  timezone: string;
};

export type CalendlyBookingLinkArgs = {
  startIso: string;
  endIso: string;
};

type ProxyLink = { connectionId: string; providerConfigKey: string };

function proxyLink(conn: ResolvedVoiceConnection): ProxyLink {
  return { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey };
}

/**
 * The connected account's user URI — the required `user` filter for the
 * event-types listing. Null when the Nango link is stale/foreign (the proxy
 * returns null for unverified links).
 */
async function resolveUserUri(
  businessId: string,
  conn: ResolvedVoiceConnection
): Promise<string | null> {
  const res = await nangoProxyForBusiness(businessId, proxyLink(conn), {
    endpoint: "/users/me",
    method: "GET"
  });
  if (!res) return null;
  const data = res.data as { resource?: { uri?: string } };
  const uri = data?.resource?.uri;
  return typeof uri === "string" && uri.length > 0 ? uri : null;
}

type EventTypesBody = {
  collection?: Array<{
    uri?: string;
    name?: string;
    duration?: number;
    active?: boolean;
    scheduling_url?: string;
  }>;
};

/**
 * The user's active event type whose duration is closest to the requested
 * duration. Returns:
 *   - `{ eventType }` on success,
 *   - `"not_connected"` when the proxy refuses the link,
 *   - `"no_event_types"` when the account has no active event types.
 */
export async function pickCalendlyEventType(
  businessId: string,
  conn: ResolvedVoiceConnection,
  durationMinutes: number
): Promise<{ eventType: CalendlyEventType } | "not_connected" | "no_event_types"> {
  const userUri = await resolveUserUri(businessId, conn);
  if (!userUri) return "not_connected";

  const res = await nangoProxyForBusiness(businessId, proxyLink(conn), {
    endpoint: "/event_types",
    method: "GET",
    params: { user: userUri, active: "true", count: "100" }
  });
  if (!res) return "not_connected";

  const items = ((res.data as EventTypesBody)?.collection ?? [])
    .filter(
      (e): e is { uri: string; name?: string; duration?: number; scheduling_url?: string } =>
        typeof e?.uri === "string" && e.uri.length > 0 && e.active !== false
    )
    .map((e) => ({
      uri: e.uri,
      name: typeof e.name === "string" ? e.name : "Appointment",
      duration: typeof e.duration === "number" && e.duration > 0 ? e.duration : 30,
      schedulingUrl: typeof e.scheduling_url === "string" ? e.scheduling_url : null
    }));
  if (items.length === 0) return "no_event_types";

  let best = items[0];
  for (const candidate of items.slice(1)) {
    const bestGap = Math.abs(best.duration - durationMinutes);
    const gap = Math.abs(candidate.duration - durationMinutes);
    if (gap < bestGap) best = candidate;
  }
  return { eventType: best };
}

type AvailableTimesBody = {
  collection?: Array<{
    status?: string;
    start_time?: string;
    scheduling_url?: string;
  }>;
};

/**
 * `calendar_find_slots` core for Calendly connections. The search window is
 * clamped to Calendly's constraints (future start, ≤ 7 days) before querying.
 */
export async function findCalendlySlots(
  businessId: string,
  conn: ResolvedVoiceConnection,
  args: CalendlyFindSlotsArgs
): Promise<CalendarToolResult> {
  const picked = await pickCalendlyEventType(businessId, conn, args.durationMinutes);
  if (picked === "not_connected") return { ok: false, detail: "calendar_not_connected" };
  if (picked === "no_event_types") return { ok: false, detail: "calendly_no_event_types" };
  const { eventType } = picked;

  const startMs = Math.max(args.windowStart.getTime(), Date.now() + CALENDLY_MIN_LEAD_MS);
  const endMs = Math.min(args.windowEnd.getTime(), startMs + CALENDLY_MAX_WINDOW_MS);
  if (endMs <= startMs) {
    // The requested window is entirely in the past.
    return { ok: false, detail: "invalid_window" };
  }

  const res = await nangoProxyForBusiness(businessId, proxyLink(conn), {
    endpoint: "/event_type_available_times",
    method: "GET",
    params: {
      event_type: eventType.uri,
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString()
    }
  });
  if (!res) return { ok: false, detail: "calendar_not_connected" };

  const durationMs = eventType.duration * 60_000;
  const slots = ((res.data as AvailableTimesBody)?.collection ?? [])
    .filter(
      (t): t is { status?: string; start_time: string } =>
        typeof t?.start_time === "string" && (t.status === undefined || t.status === "available")
    )
    .slice(0, MAX_SLOTS)
    .map((t) => {
      const start = new Date(t.start_time);
      return {
        startIso: start.toISOString(),
        endIso: new Date(start.getTime() + durationMs).toISOString()
      };
    });

  return {
    ok: true,
    data: {
      slots,
      timezone: args.timezone,
      purpose: args.purpose ?? null,
      // Calendly event types have a FIXED duration; echo the real one so the
      // model presents accurate times even when the request asked for another.
      durationMinutes: eventType.duration,
      provider: "calendly",
      eventTypeName: eventType.name,
      schedulingUrl: eventType.schedulingUrl
    }
  };
}

type SchedulingLinkBody = {
  resource?: { booking_url?: string };
};

/**
 * `calendar_book_appointment` core for Calendly connections. Creates a
 * SINGLE-USE scheduling link for the best-matching event type. The result is
 * ok:true with detail `booking_link_created` — the appointment does not exist
 * until the customer completes the Calendly page, and the tool copy tells the
 * model to send `bookingLink` onward rather than confirm a booked time.
 */
export async function createCalendlyBookingLink(
  businessId: string,
  conn: ResolvedVoiceConnection,
  args: CalendlyBookingLinkArgs
): Promise<CalendarToolResult> {
  const requestedMinutes = Math.max(
    1,
    Math.round((new Date(args.endIso).getTime() - new Date(args.startIso).getTime()) / 60_000)
  );
  const picked = await pickCalendlyEventType(businessId, conn, requestedMinutes);
  if (picked === "not_connected") return { ok: false, detail: "calendar_not_connected" };
  if (picked === "no_event_types") return { ok: false, detail: "calendly_no_event_types" };
  const { eventType } = picked;

  const res = await nangoProxyForBusiness(businessId, proxyLink(conn), {
    endpoint: "/scheduling_links",
    method: "POST",
    data: {
      max_event_count: 1,
      owner: eventType.uri,
      owner_type: "EventType"
    }
  });
  if (!res) return { ok: false, detail: "calendar_not_connected" };

  const bookingUrl = (res.data as SchedulingLinkBody)?.resource?.booking_url;
  if (typeof bookingUrl !== "string" || bookingUrl.length === 0) {
    return { ok: false, detail: "calendar_book_failed" };
  }

  return {
    ok: true,
    detail: "booking_link_created",
    data: {
      // Keep the Google/Microsoft success keys so downstream consumers that
      // read eventId/htmlLink/provider/calendar keep working.
      eventId: null,
      htmlLink: bookingUrl,
      provider: "calendly",
      calendar: "calendly",
      bookingLink: bookingUrl,
      eventTypeName: eventType.name
    }
  };
}
