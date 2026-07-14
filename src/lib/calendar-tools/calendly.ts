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
 * requested duration (ties go to the earlier listing).
 *
 * Two transports, chosen by the resolved connection's providerConfigKey:
 *   - "calendly" (Nango OAuth) → the Nango proxy, which re-verifies the
 *     connection belongs to the business;
 *   - CALENDLY_DIRECT_KEY (dashboard-pasted Personal Access Token) → direct
 *     calls to api.calendly.com via src/lib/calendly/client.ts.
 * Both return the same `{ data } | null` shape, so everything below is
 * transport-agnostic.
 */

import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { calendlyDirectRequest } from "@/lib/calendly/client";
import { getActiveCalendlyConnection } from "@/lib/db/calendly-connections";
import {
  CALENDLY_DIRECT_KEY,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
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

type CalendlyRequestConfig = {
  endpoint: string;
  method: "GET" | "POST";
  params?: Record<string, string>;
  data?: unknown;
};

/**
 * Transport-agnostic request: direct PAT for dashboard-connected accounts,
 * the Nango proxy otherwise. Null means "not usable" for BOTH transports
 * (missing/inactive direct row or revoked PAT; stale/foreign Nango link),
 * which callers map to `calendar_not_connected`.
 */
async function calendlyRequest(
  businessId: string,
  conn: ResolvedVoiceConnection,
  config: CalendlyRequestConfig
): Promise<{ data: unknown } | null> {
  if (conn.providerConfigKey === CALENDLY_DIRECT_KEY) {
    const row = await getActiveCalendlyConnection(businessId);
    if (!row) return null;
    return calendlyDirectRequest(row.accessToken, config);
  }
  return nangoProxyForBusiness(businessId, proxyLink(conn), config);
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
  const res = await calendlyRequest(businessId, conn, {
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

  const res = await calendlyRequest(businessId, conn, {
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

  const res = await calendlyRequest(businessId, conn, {
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

// ── Appointment lifecycle (reschedule / cancel) ─────────────────────────────
//
// A Calendly "booking" is completed by the INVITEE on a Calendly page, so no
// event id ever lands in our booking ledger — lifecycle operations locate the
// scheduled event through Calendly's own API instead: list the user's active
// upcoming events, then match an invitee by email or SMS-reminder number.
//
//   - cancel      → POST /scheduled_events/{uuid}/cancellation: a REAL
//     cancellation; Calendly emails the invitee exactly one notice.
//   - reschedule  → Calendly cannot move an event on the invitee's behalf
//     (same constraint as booking). Every invitee carries a reschedule_url,
//     so the core returns it with the distinct detail
//     `reschedule_link_created` — the model sends the link and must never
//     describe the reschedule as done (mirrors booking_link_created).

/** Upcoming events scanned when matching the customer. */
const LIFECYCLE_EVENT_SCAN = 20;

/** Digits-only comparison for phone markers ("+1 (548) 577-3546" ≈ +15485773546). */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * The shortest digit string that still identifies a subscriber (national
 * significant numbers are 7+ digits everywhere); anything shorter is too
 * ambiguous to suffix-match safely.
 */
const MIN_PHONE_MATCH_DIGITS = 7;

/**
 * Country-code-tolerant phone comparison: our side holds E.164 ("+1548…")
 * while Calendly may store the invitee's number nationally ("548…") or vice
 * versa, so exact digit equality misses real matches (Bugbot on PR #584).
 * Suffix containment with a minimum length keeps "5773546" from matching an
 * unrelated number while letting the country-code variants agree.
 */
function phoneDigitsMatch(a: string, b: string): boolean {
  if (a.length < MIN_PHONE_MATCH_DIGITS || b.length < MIN_PHONE_MATCH_DIGITS) {
    return a.length > 0 && a === b;
  }
  return a.endsWith(b) || b.endsWith(a);
}

type ScheduledEventsBody = {
  collection?: Array<{ uri?: string; start_time?: string }>;
};

type InviteesBody = {
  collection?: Array<{
    email?: string;
    text_reminder_number?: string;
    reschedule_url?: string;
    cancel_url?: string;
    status?: string;
  }>;
};

export type CalendlyLocatedEvent = {
  /** Full event URI (https://api.calendly.com/scheduled_events/UUID). */
  eventUri: string;
  /** Bare UUID, used for the cancellation POST. */
  eventUuid: string;
  rescheduleUrl: string | null;
};

/**
 * The customer's next upcoming active event, matched by invitee email or
 * SMS number. Returns:
 *   - `{ event }` on a match,
 *   - `"not_connected"` when the transport refuses,
 *   - `"not_found"` when no upcoming event has a matching active invitee.
 */
export async function findCalendlyScheduledEvent(
  businessId: string,
  conn: ResolvedVoiceConnection,
  attendee: { phone?: string | null; email?: string | null }
): Promise<{ event: CalendlyLocatedEvent } | "not_connected" | "not_found"> {
  const phoneDigits = attendee.phone?.trim() ? digitsOf(attendee.phone) : "";
  const emailLc = attendee.email?.trim().toLowerCase() ?? "";
  if (!phoneDigits && !emailLc) return "not_found";

  const userUri = await resolveUserUri(businessId, conn);
  if (!userUri) return "not_connected";

  const eventsRes = await calendlyRequest(businessId, conn, {
    endpoint: "/scheduled_events",
    method: "GET",
    params: {
      user: userUri,
      status: "active",
      min_start_time: new Date().toISOString(),
      sort: "start_time:asc",
      count: String(LIFECYCLE_EVENT_SCAN)
    }
  });
  if (!eventsRes) return "not_connected";

  const events = ((eventsRes.data as ScheduledEventsBody)?.collection ?? []).filter(
    (e): e is { uri: string } => typeof e?.uri === "string" && e.uri.length > 0
  );
  for (const event of events) {
    const eventUuid = event.uri.slice(event.uri.lastIndexOf("/") + 1);
    if (!eventUuid) continue;
    const inviteesRes = await calendlyRequest(businessId, conn, {
      endpoint: `/scheduled_events/${encodeURIComponent(eventUuid)}/invitees`,
      method: "GET",
      params: { count: "10" }
    });
    if (!inviteesRes) return "not_connected";
    const invitees = ((inviteesRes.data as InviteesBody)?.collection ?? []).filter(
      (i) => i?.status !== "canceled"
    );
    const match = invitees.find((i) => {
      const inviteeEmail = typeof i.email === "string" ? i.email.toLowerCase() : "";
      const inviteePhone =
        typeof i.text_reminder_number === "string" ? digitsOf(i.text_reminder_number) : "";
      return (
        (emailLc.length > 0 && inviteeEmail === emailLc) ||
        (phoneDigits.length > 0 &&
          inviteePhone.length > 0 &&
          phoneDigitsMatch(inviteePhone, phoneDigits))
      );
    });
    if (match) {
      return {
        event: {
          eventUri: event.uri,
          eventUuid,
          rescheduleUrl:
            typeof match.reschedule_url === "string" && match.reschedule_url.length > 0
              ? match.reschedule_url
              : null
        }
      };
    }
  }
  return "not_found";
}

/**
 * `calendar_cancel_appointment` core for Calendly connections: a real
 * API-side cancellation — Calendly emails the invitee ONE notice.
 */
export async function cancelCalendlyAppointment(
  businessId: string,
  conn: ResolvedVoiceConnection,
  attendee: { phone?: string | null; email?: string | null }
): Promise<CalendarToolResult> {
  const located = await findCalendlyScheduledEvent(businessId, conn, attendee);
  if (located === "not_connected") return { ok: false, detail: "calendar_not_connected" };
  if (located === "not_found") return { ok: false, detail: "booking_not_found" };

  const res = await calendlyRequest(businessId, conn, {
    endpoint: `/scheduled_events/${encodeURIComponent(located.event.eventUuid)}/cancellation`,
    method: "POST",
    data: { reason: "Canceled at the customer's request via the business's assistant." }
  });
  if (!res) return { ok: false, detail: "calendar_not_connected" };

  return {
    ok: true,
    data: { eventId: located.event.eventUuid, provider: "calendly", canceled: true }
  };
}

/**
 * `calendar_reschedule_appointment` core for Calendly connections: returns
 * the invitee's own reschedule link (detail `reschedule_link_created`) —
 * Calendly cannot move an event on the invitee's behalf, so the customer
 * picks the new time themselves and the SAME event is updated by Calendly.
 */
export async function createCalendlyRescheduleLink(
  businessId: string,
  conn: ResolvedVoiceConnection,
  attendee: { phone?: string | null; email?: string | null }
): Promise<CalendarToolResult> {
  const located = await findCalendlyScheduledEvent(businessId, conn, attendee);
  if (located === "not_connected") return { ok: false, detail: "calendar_not_connected" };
  if (located === "not_found") return { ok: false, detail: "booking_not_found" };
  if (!located.event.rescheduleUrl) {
    // An active invitee without a reschedule_url is unexpected; treat it as
    // a failed reschedule so the model escalates instead of inventing links.
    return { ok: false, detail: "calendar_reschedule_failed" };
  }

  return {
    ok: true,
    detail: "reschedule_link_created",
    data: {
      eventId: located.event.eventUuid,
      provider: "calendly",
      rescheduleLink: located.event.rescheduleUrl,
      rescheduled: false
    }
  };
}

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

  const res = await calendlyRequest(businessId, conn, {
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
