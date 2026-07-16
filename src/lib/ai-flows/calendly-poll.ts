/**
 * Calendly candidate-event fetcher for the AiFlow calendar-trigger poller.
 *
 * Calendly tenants (e.g. agencies whose whole book lives on Calendly links)
 * had NO working calendar triggers: the poller's fetchers speak Google/Graph
 * only, so `event_start` reminder flows — "text the invitee 2-3 hours before
 * our call" (KYP Ads' top ask) — were impossible. This module lists the
 * connected account's scheduled events over the poller's mode windows and
 * normalizes them into the same `CalendarEventInput` shape the Google/Graph
 * fetchers produce, so due-checks, conditions, dedupe keys, and enqueueing
 * work unchanged.
 *
 * Notable differences from the workspace providers:
 *   - There is no "shared" calendar; every event lands on the "primary"
 *     source, and shared-only flows simply see no Calendly events.
 *   - The scheduled-events listing carries no invitee details, so due events
 *     are ENRICHED with a per-event invitees call (name, email, SMS-reminder
 *     phone, TIMEZONE, invitee-local start time, reschedule/cancel links,
 *     and lead-form Q&A) — that context lands in the event description, so
 *     trigger conditions AND flow steps ({{trigger.windowText}} →
 *     extract_text) can use it. The invitee timezone matters because a
 *     "confirm our call at [time] today" text must quote the INVITEE's local
 *     time, not the business's. Enrichment is additive and never fatal: an
 *     invitees call failing still fires the flow with event-only context.
 *   - `event_created` has no server-side created-at filter, so the fetcher
 *     scans upcoming events (bounded window) and the poller's
 *     `eventCreatedDue` lookback does the actual gating — identical to how
 *     Google's `updatedMin` over-listing is narrowed downstream.
 */

import { calendlyRequest, type CalendlyRequestConfig } from "@/lib/calendar-tools/calendly";
import type { ResolvedVoiceConnection } from "@/lib/voice-tools/connections";
import type { CalendarEventInput } from "@/lib/ai-flows/trigger-eval";
import { logger } from "@/lib/logger";

/** Calendly's max page size — a full page flags the poll as overflowed. */
export const CALENDLY_POLL_PAGE_COUNT = 100;

/**
 * Cap on per-tick invitee-enrichment calls per business. Due events are few
 * in practice (a start window is a few hours; created/canceled lookbacks are
 * minutes), so this only bites on pathological calendars — flagged as
 * overflow rather than silently dropped.
 */
export const CALENDLY_INVITEE_FETCH_CAP = 25;

/**
 * event_created scans this many days of UPCOMING events (Calendly cannot
 * filter by creation time server-side; `eventCreatedDue` narrows to the
 * real lookback). An event created for a start beyond the scan window fires
 * late or not at all — acceptable: creation-triggered flows act on fresh
 * bookings, which overwhelmingly start within days.
 */
export const CALENDLY_CREATED_SCAN_DAYS = 30;

/**
 * end-mode listing assumes no event runs longer than this (the listing
 * filters on START time, so the window must reach back far enough to catch
 * a long event whose END is only now due).
 */
export const CALENDLY_END_MAX_EVENT_MINUTES = 6 * 60;

/**
 * event_canceled scan bounds. Calendly's listing can only filter on START
 * time (no modified-since filter, unlike Google's updatedMin), so the poll
 * scans canceled events whose start falls in [-back, +forward] and lets
 * `eventCanceledDue` gate on the cancellation moment (updated_at). The
 * forward horizon covers Calendly's own scheduling reality — event types
 * cap their booking window (60/90 days typical), so a cancellation on an
 * event starting beyond it is vanishingly rare; one that still happens is
 * missed, a documented Calendly API limitation rather than a bug.
 */
export const CALENDLY_CANCELED_SCAN_BACK_DAYS = 1;
export const CALENDLY_CANCELED_SCAN_FORWARD_DAYS = 90;

type RawLocation = { type?: string; location?: string | null; join_url?: string };

type RawScheduledEvent = {
  uri?: string;
  name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  updated_at?: string;
  location?: RawLocation;
};

type RawInvitee = {
  name?: string;
  email?: string;
  status?: string;
  timezone?: string;
  text_reminder_number?: string;
  reschedule_url?: string;
  cancel_url?: string;
  questions_and_answers?: Array<{ question?: string; answer?: string }>;
};

/** Bare UUID from a full Calendly resource URI ("" when unparseable). */
export function calendlyEventUuid(uri: string): string {
  const idx = uri.lastIndexOf("/");
  return idx >= 0 ? uri.slice(idx + 1) : uri;
}

function locationText(loc: RawLocation | undefined): string | undefined {
  if (!loc) return undefined;
  if (typeof loc.join_url === "string" && loc.join_url.length > 0) return loc.join_url;
  if (typeof loc.location === "string" && loc.location.length > 0) return loc.location;
  if (typeof loc.type === "string" && loc.type.length > 0) return loc.type;
  return undefined;
}

/** Calendly scheduled event → the poller's normalized shape. */
export function normalizeCalendlyEvent(raw: RawScheduledEvent): CalendarEventInput | null {
  if (typeof raw.uri !== "string" || raw.uri.length === 0) return null;
  const id = calendlyEventUuid(raw.uri);
  if (!id) return null;
  return {
    id,
    title: typeof raw.name === "string" ? raw.name : "",
    location: locationText(raw.location),
    startIso: raw.start_time,
    endIso: raw.end_time,
    createdIso: raw.created_at,
    updatedIso: raw.updated_at,
    // Kept (not dropped) so the event_canceled mode can fire; every other
    // due-check skips cancelled events explicitly (poller parity).
    cancelled: raw.status === "canceled",
    // Calendly has no shared-calendar concept — everything is "primary".
    calendar: "primary"
  };
}

/**
 * The invitee's local wall-clock start ("2:00 PM on Thursday, July 16,
 * 2026"), so reminder texts quote THEIR time. Null when the start or the
 * timezone is unusable — callers omit the line rather than lying.
 */
export function formatInviteeLocalTime(
  startIso: string | undefined,
  timezone: string | undefined
): string | null {
  if (!startIso || !timezone) return null;
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour12: true
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

/**
 * Fold one event's invitees into its normalized shape: attendee display
 * strings plus a description block of invitee context lines. Cancelled
 * invitees are skipped on active events but INCLUDED on a cancelled event
 * (they are exactly who a cancellation flow needs to reach).
 */
export function applyInviteeContext(ev: CalendarEventInput, invitees: RawInvitee[]): void {
  const relevant = invitees.filter((i) =>
    ev.cancelled ? true : i?.status !== "canceled"
  );
  const attendees: string[] = [];
  const lines: string[] = [];
  for (const invitee of relevant) {
    const name = typeof invitee.name === "string" ? invitee.name.trim() : "";
    const email = typeof invitee.email === "string" ? invitee.email.trim() : "";
    if (name && email) attendees.push(`${name} <${email}>`);
    else if (email) attendees.push(email);
    else if (name) attendees.push(name);

    if (name) lines.push(`invitee name: ${name}`);
    if (email) lines.push(`invitee email: ${email}`);
    if (typeof invitee.text_reminder_number === "string" && invitee.text_reminder_number) {
      lines.push(`invitee phone: ${invitee.text_reminder_number}`);
    }
    if (typeof invitee.timezone === "string" && invitee.timezone) {
      lines.push(`invitee timezone: ${invitee.timezone}`);
      const local = formatInviteeLocalTime(ev.startIso, invitee.timezone);
      if (local) lines.push(`starts (invitee local time): ${local}`);
    }
    if (typeof invitee.reschedule_url === "string" && invitee.reschedule_url) {
      lines.push(`reschedule link: ${invitee.reschedule_url}`);
    }
    if (typeof invitee.cancel_url === "string" && invitee.cancel_url) {
      lines.push(`cancel link: ${invitee.cancel_url}`);
    }
    for (const qa of invitee.questions_and_answers ?? []) {
      const q = typeof qa?.question === "string" ? qa.question.trim() : "";
      const a = typeof qa?.answer === "string" ? qa.answer.trim() : "";
      if (q && a) lines.push(`answer "${q}": ${a}`);
    }
  }
  if (attendees.length > 0) ev.attendees = attendees;
  if (lines.length > 0) {
    ev.description = ev.description ? `${ev.description}\n${lines.join("\n")}` : lines.join("\n");
  }
}

export type CalendlyPollWindows = {
  /** Any event_created flow present (scan upcoming, lookback-gated later). */
  createdScan: boolean;
  /** Largest event_start lead + buffer, or null when no start-mode flow. */
  startHorizonMinutes: number | null;
  /** Largest event_end follow + lookback, or null when no end-mode flow. */
  endBackMinutes: number | null;
  /** Any event_canceled flow present. */
  canceledScan: boolean;
};

export type CalendlyFetch = { events: CalendarEventInput[]; overflowed: boolean };

export type CalendlyPollDeps = {
  /** Injectable transport (tests). */
  request?: (
    businessId: string,
    conn: ResolvedVoiceConnection,
    config: CalendlyRequestConfig
  ) => Promise<{ data: unknown } | null>;
};

/**
 * List + normalize + due-filter + invitee-enrich this business's Calendly
 * candidate events for one poll tick. Throws `calendar_not_connected` when
 * the transport refuses (matching the workspace fetchers' contract); the
 * caller's per-business isolation turns that into a system log.
 *
 * `dueFilter` is the poller's own due logic (mode windows over the flow
 * group) so enrichment — one invitees call per event — is spent on events
 * that can actually fire, not the whole scan.
 */
export async function fetchCalendlyCandidateEvents(
  args: {
    businessId: string;
    conn: ResolvedVoiceConnection;
    nowMs: number;
    windows: CalendlyPollWindows;
    dueFilter: (ev: CalendarEventInput) => boolean;
  },
  deps: CalendlyPollDeps = {}
): Promise<CalendlyFetch> {
  /* c8 ignore next -- production default; tests inject */
  const request = deps.request ?? calendlyRequest;
  const { businessId, conn, nowMs, windows } = args;

  const userRes = await request(businessId, conn, { endpoint: "/users/me", method: "GET" });
  if (!userRes) throw new Error("calendar_not_connected");
  const userUri = (userRes.data as { resource?: { uri?: string } })?.resource?.uri;
  if (typeof userUri !== "string" || userUri.length === 0) {
    throw new Error("calendar_not_connected");
  }

  const collected: CalendarEventInput[] = [];
  const seen = new Set<string>();
  let overflowed = false;
  const iso = (ms: number) => new Date(ms).toISOString();
  const minuteMs = 60_000;
  const dayMs = 24 * 60 * minuteMs;

  const list = async (params: Record<string, string>): Promise<void> => {
    const res = await request(businessId, conn, {
      endpoint: "/scheduled_events",
      method: "GET",
      params: {
        user: userUri,
        sort: "start_time:asc",
        count: String(CALENDLY_POLL_PAGE_COUNT),
        ...params
      }
    });
    if (!res) throw new Error("calendar_not_connected");
    const items = ((res.data as { collection?: RawScheduledEvent[] })?.collection ?? [])
      .map(normalizeCalendlyEvent)
      .filter((e): e is CalendarEventInput => e !== null);
    overflowed ||= items.length >= CALENDLY_POLL_PAGE_COUNT;
    for (const ev of items) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      collected.push(ev);
    }
  };

  // Per-window isolation (workspace-path parity): one window's failure must
  // not drop the events earlier windows already collected — log and keep
  // going; dedupe keys make the retry on the next tick benign. Only when
  // EVERY window failed and nothing was collected does the not-connected
  // contract fire, so the poller's business-level log still says why.
  let windowFailure: unknown = null;
  const listSafely = async (label: string, params: Record<string, string>): Promise<void> => {
    try {
      await list(params);
    } catch (err) {
      windowFailure = err;
      logger.warn("calendly poll: window listing failed", {
        businessId,
        window: label,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  if (windows.createdScan) {
    await listSafely("created", {
      status: "active",
      min_start_time: iso(nowMs),
      max_start_time: iso(nowMs + CALENDLY_CREATED_SCAN_DAYS * dayMs)
    });
  }
  if (windows.startHorizonMinutes !== null) {
    await listSafely("start", {
      status: "active",
      min_start_time: iso(nowMs),
      max_start_time: iso(nowMs + windows.startHorizonMinutes * minuteMs)
    });
  }
  if (windows.endBackMinutes !== null) {
    // The listing filters on START time; reach back far enough that a long
    // event whose END is only now due is still listed.
    await listSafely("end", {
      status: "active",
      min_start_time: iso(
        nowMs - (windows.endBackMinutes + CALENDLY_END_MAX_EVENT_MINUTES) * minuteMs
      ),
      max_start_time: iso(nowMs)
    });
  }
  if (windows.canceledScan) {
    await listSafely("canceled", {
      status: "canceled",
      min_start_time: iso(nowMs - CALENDLY_CANCELED_SCAN_BACK_DAYS * dayMs),
      max_start_time: iso(nowMs + CALENDLY_CANCELED_SCAN_FORWARD_DAYS * dayMs)
    });
  }
  if (collected.length === 0 && windowFailure !== null) {
    throw windowFailure instanceof Error ? windowFailure : new Error(String(windowFailure));
  }

  const due = collected.filter(args.dueFilter);

  // Invitee enrichment for due events only, capped. Additive and non-fatal:
  // a failed invitees call leaves the event firing with event-only context.
  let enriched = 0;
  for (const ev of due) {
    if (enriched >= CALENDLY_INVITEE_FETCH_CAP) {
      overflowed = true;
      break;
    }
    enriched += 1;
    try {
      const res = await request(businessId, conn, {
        endpoint: `/scheduled_events/${encodeURIComponent(ev.id)}/invitees`,
        method: "GET",
        params: { count: "10" }
      });
      if (!res) continue;
      const invitees = (res.data as { collection?: RawInvitee[] })?.collection ?? [];
      applyInviteeContext(ev, invitees);
    } catch (err) {
      logger.warn("calendly poll: invitee enrichment failed", {
        businessId,
        eventId: ev.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { events: due, overflowed };
}
