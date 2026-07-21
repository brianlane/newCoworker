/**
 * Calendar-event trigger poller.
 *
 * Driven by /api/internal/aiflow-calendar-poll (which the ai-flow-worker's
 * cron tick kicks ~1/min, alongside the email poll): finds every ENABLED flow
 * whose trigger channel is "calendar", reads the watched calendar(s) through
 * the business's connected calendar account (resolved exactly like the
 * calendar tools — no connectionId lives in the trigger), evaluates the
 * flow's conditions over the event text, and enqueues a queued ai_flow_run
 * per match. Google/Microsoft calendars poll through the Nango fetchers
 * below; Calendly connections poll through the dedicated fetcher in
 * calendly-poll.ts (scheduled events + invitee enrichment — Calendly-only
 * tenants like KYP Ads previously had NO working calendar triggers), and
 * Vagaro connections through vagaro-poll.ts (appointments listing; the
 * Vagaro webhook receiver also fires created/canceled in real time with
 * the same dedupe keys, so poll/webhook double-observation is a no-op).
 *
 * Three firing modes per flow:
 *   - event_created: an event whose `created` timestamp falls inside the poll
 *     lookback window (dedupe key `cal:<eventId>`).
 *   - event_start: an event starting within the next `leadMinutes` (dedupe
 *     key `cal:<eventId>:<startIso>`, so each occurrence of a recurring event
 *     fires once — and a reschedule legitimately fires again).
 *   - event_end: an event whose ACTUAL end time passed `followMinutes` ago
 *     (dedupe key `cal:<eventId>:end:<endIso>`). Anchored to the event's real
 *     end, so a post-appointment follow-up works for a 30-minute and a 2-hour
 *     appointment alike — no guessed sleep after an event_start trigger.
 *
 * Exactly-once: the unique (flow_id, dedupe_key) index on ai_flow_runs
 * absorbs repeat polls, so unlike the email poller there is no seen-marker
 * table — the list responses already carry every field we evaluate, so
 * re-evaluating a non-matching event each tick costs nothing extra.
 *
 * Failure isolation: one business failing (no calendar connected, revoked
 * grant, provider 5xx) logs to system_logs and moves on; it can never block
 * other tenants' flows or the worker tick that kicked the poll.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness, type NangoWorkspaceLink } from "@/lib/nango/workspace";
import {
  isWorkspaceCalendarProvider,
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { fetchCalendlyCandidateEvents } from "@/lib/ai-flows/calendly-poll";
import { fetchVagaroCandidateEvents } from "@/lib/ai-flows/vagaro-poll";
import {
  calendarTriggerScope,
  evaluateTriggerConditions,
  type CalendarEventInput
} from "@/lib/ai-flows/trigger-eval";
import { recordSystemLog } from "@/lib/db/system-logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import type { TriggerCondition } from "@/lib/ai-flows/schema";
import {
  resolveFromMatchesRefValues,
  type ContactRefSupabase
} from "../../../supabase/functions/_shared/ai_flows/contact_ref";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** event_created lookback per poll. Must exceed the poll interval (~1 min). */
export const CALENDAR_CREATED_LOOKBACK_MINUTES = 15;

/**
 * How long an event_end firing stays due past its exact moment (end +
 * followMinutes). Covers missed ticks the same way the created lookback does,
 * while keeping a flow that was disabled for a week from firing for every
 * appointment in between when re-enabled.
 */
export const CALENDAR_END_LOOKBACK_MINUTES = 15;

/**
 * How long a cancellation stays due past its modification time. Same
 * missed-tick coverage rationale as the created lookback.
 */
export const CALENDAR_CANCELED_LOOKBACK_MINUTES = 15;

/**
 * Cap on events read per (calendar, query) per poll. Calendars are orders of
 * magnitude quieter than mailboxes, so a single capped page suffices; a full
 * page is flagged with an overflow warning instead of paging further.
 */
export const CALENDAR_POLL_MAX_EVENTS = 100;

/** Page size for the flow listing — paged so no flow is silently skipped. */
export const CALENDAR_POLL_FLOW_PAGE = 100;

/**
 * Extra minutes added to the event_start fetch window beyond the largest
 * leadMinutes. Both providers treat the window's upper bound as EXCLUSIVE, so
 * an event starting exactly at `now + lead` — precisely the moment it first
 * becomes due — would otherwise be omitted from the listing until a later
 * tick (and with a 1-minute lead, never listed while still due). The due
 * check (eventStartDue) still gates enqueueing, so the buffer only widens
 * what is read, not what fires.
 */
export const CALENDAR_START_HORIZON_BUFFER_MINUTES = 5;

/**
 * How many PRIOR failures inside the escalation window a connection-class
 * failure needs before the owner is alerted (i.e. the alert fires on the
 * third consecutive failing poll — a blip never pings the owner).
 */
export const CALENDAR_POLL_ALERT_PRIOR_FAILURES = 2;

/** Marker event for the once-per-day owner alert dedupe. */
export const CALENDAR_POLL_OWNER_ALERT_EVENT = "ai_flow_calendar_owner_alerted";

/** Failure details that mean "the calendar connection itself is broken". */
const CONNECTION_FAILURE_DETAILS = [
  "calendar_not_connected",
  "calendly_token_rejected",
  "workspace_connection_rejected"
] as const;

/**
 * Minimum spacing between REAL polls. The worker kicks this route every
 * minute, but the trigger due-windows (15-minute lookbacks; event_start
 * fires anywhere inside its lead window) make per-minute provider listings
 * pure waste — one real poll per ~3 minutes has identical trigger behavior
 * at a third of the Calendly/Google/Microsoft calls. 10s under the nominal
 * 3 minutes so pg_cron jitter can't make every third tick miss the gate.
 */
export const CALENDAR_POLL_MIN_INTERVAL_MS = 3 * 60_000 - 10_000;

/**
 * The cadence gate only engages when EVERY event_start flow's leadMinutes
 * exceeds this. An event_start due window is exactly leadMinutes wide
 * ([start - lead, start)) with no lookback — a window shorter than the
 * gated interval could fall entirely between two real polls and the
 * reminder would never fire. Leads above 5 minutes leave comfortable
 * margin over the ~2m50s interval plus cron jitter; anything at or below
 * it keeps the poll at the worker's native per-minute cadence.
 */
export const CALENDAR_GATE_MIN_START_LEAD_MINUTES = 5;

/** Marker event stamped once per real poll (business_id null, debug level). */
export const CALENDAR_POLL_TICK_EVENT = "ai_flow_calendar_poll_tick";

/**
 * Escalation lookback, tied to the REAL poll cadence: exactly wide enough to
 * hold the two immediately preceding real polls (plus jitter slack), so
 * "N prior failures inside the window" genuinely means "the last N polls
 * failed too". A healthy poll between failures leaves a full poll interval
 * with no failure row, pushing the older failure out of the window — a
 * recovered connection can never accumulate stale strikes toward the owner
 * alert (each business logs at most ONE failure row per real poll; see
 * pollCalendarTriggers' per-business aggregation).
 */
export const CALENDAR_POLL_FAILURE_ESCALATION_MS =
  CALENDAR_POLL_ALERT_PRIOR_FAILURES * CALENDAR_POLL_MIN_INTERVAL_MS + 2 * 60_000;

type CalendarSource = "primary" | "shared";

export type CalendarFlow = {
  /** Unique per (flow, trigger index) — one flow can carry several calendar triggers. */
  key: string;
  id: string;
  business_id: string;
  /** Which calendar(s) the flow watches ("both" expands to primary+shared). */
  sources: CalendarSource[];
  on: "event_created" | "event_start" | "event_end" | "event_canceled";
  leadMinutes: number;
  /** event_end only: minutes after the event's actual end (0 = right at it). */
  followMinutes: number;
  conditions: TriggerCondition[];
};

export type CalendarPollResult = {
  flows: number;
  businesses: number;
  events: number;
  enqueued: number;
  /** True when the cadence gate skipped this tick (a recent poll covered it). */
  skipped?: boolean;
};

/** Whether an event_start flow is due for `ev` at `nowMs` (pure, for tests). */
export function eventStartDue(
  ev: Pick<CalendarEventInput, "startIso" | "allDay" | "cancelled">,
  leadMinutes: number,
  nowMs: number
): boolean {
  // A cancelled event never "starts"; only event_canceled fires for it.
  if (ev.cancelled) return false;
  // An all-day event's "start" is a calendar-local date, not a moment in
  // time — a minutes-before reminder would fire at an arbitrary wall-clock
  // time, so start-mode skips all-day events (created mode still fires).
  if (ev.allDay) return false;
  if (!ev.startIso) return false;
  const startMs = Date.parse(ev.startIso);
  if (!Number.isFinite(startMs)) return false;
  // Due from `leadMinutes` before the start until the event actually starts,
  // so a missed tick still fires as long as the reminder is still useful.
  return startMs - leadMinutes * 60_000 <= nowMs && startMs > nowMs;
}

/** Whether an event_end flow is due for `ev` at `nowMs` (pure, for tests). */
export function eventEndDue(
  ev: Pick<CalendarEventInput, "endIso" | "allDay" | "cancelled">,
  followMinutes: number,
  nowMs: number
): boolean {
  // A cancelled event never "ends"; only event_canceled fires for it.
  if (ev.cancelled) return false;
  // An all-day event's "end" is a calendar-local date, not a moment in time —
  // skipped for the same reason event_start skips all-day events.
  if (ev.allDay) return false;
  if (!ev.endIso) return false;
  const endMs = Date.parse(ev.endIso);
  if (!Number.isFinite(endMs)) return false;
  const dueMs = endMs + followMinutes * 60_000;
  // Due from the exact moment for a bounded lookback, so a missed tick still
  // fires but a re-enabled flow doesn't replay old appointments.
  return dueMs <= nowMs && nowMs < dueMs + CALENDAR_END_LOOKBACK_MINUTES * 60_000;
}

/** Whether an event_created flow should fire for `ev` at `nowMs` (pure). */
export function eventCreatedDue(
  ev: Pick<CalendarEventInput, "createdIso" | "cancelled">,
  nowMs: number
): boolean {
  // Created-then-immediately-cancelled events never fire created mode.
  if (ev.cancelled) return false;
  if (!ev.createdIso) return false;
  const createdMs = Date.parse(ev.createdIso);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs >= nowMs - CALENDAR_CREATED_LOOKBACK_MINUTES * 60_000;
}

/** Whether an event_canceled flow should fire for `ev` at `nowMs` (pure). */
export function eventCanceledDue(
  ev: Pick<CalendarEventInput, "cancelled" | "updatedIso">,
  nowMs: number
): boolean {
  // Only cancelled events, and only within the lookback of the moment they
  // were modified (= cancelled) — a flow re-enabled a week later must not
  // replay every historical cancellation.
  if (!ev.cancelled) return false;
  if (!ev.updatedIso) return false;
  const updatedMs = Date.parse(ev.updatedIso);
  if (!Number.isFinite(updatedMs)) return false;
  return updatedMs >= nowMs - CALENDAR_CANCELED_LOOKBACK_MINUTES * 60_000;
}

/** Whether `flow` is due for `ev` at `nowMs` — one place for the mode fork. */
export function flowDueForEvent(
  flow: Pick<CalendarFlow, "on" | "leadMinutes" | "followMinutes">,
  ev: CalendarEventInput,
  nowMs: number
): boolean {
  return flow.on === "event_start"
    ? eventStartDue(ev, flow.leadMinutes, nowMs)
    : flow.on === "event_end"
      ? eventEndDue(ev, flow.followMinutes, nowMs)
      : flow.on === "event_canceled"
        ? eventCanceledDue(ev, nowMs)
        : eventCreatedDue(ev, nowMs);
}

/** Run-dedupe key for a due event (per-occurrence in start/end modes). */
export function calendarDedupeKey(
  on: CalendarFlow["on"],
  ev: Pick<CalendarEventInput, "id" | "startIso" | "endIso">
): string {
  if (on === "event_start") return `cal:${ev.id}:${ev.startIso ?? ""}`;
  // The `end:` segment keeps an end firing distinct from a start firing when
  // one flow (or two flows sharing an event) uses both modes.
  if (on === "event_end") return `cal:${ev.id}:end:${ev.endIso ?? ""}`;
  // One firing per cancellation (an event cancelled once stays cancelled).
  if (on === "event_canceled") return `cal:${ev.id}:cancelled`;
  return `cal:${ev.id}`;
}

// ── Google normalization ────────────────────────────────────────────────────

type GoogleEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  updated?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; displayName?: string }>;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** Google start/end → ISO (all-day `date` becomes midnight UTC). */
function googleTimeIso(t: GoogleEvent["start"]): string | undefined {
  if (t?.dateTime) return t.dateTime;
  if (t?.date) return `${t.date}T00:00:00Z`;
  return undefined;
}

export function normalizeGoogleEvent(
  raw: GoogleEvent,
  calendar: CalendarSource
): CalendarEventInput | null {
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    // A date-only start marks an all-day event (its ISO form below is a
    // convention, not a real instant — see CalendarEventInput.allDay).
    allDay: raw.start?.date !== undefined,
    title: raw.summary ?? "",
    description: raw.description,
    location: raw.location,
    organizerEmail: raw.organizer?.email,
    attendees: (raw.attendees ?? [])
      .map((a) => (a.displayName && a.email ? `${a.displayName} <${a.email}>` : a.email ?? ""))
      .filter((a) => a.length > 0),
    startIso: googleTimeIso(raw.start),
    endIso: googleTimeIso(raw.end),
    createdIso: raw.created,
    updatedIso: raw.updated,
    // Kept (not dropped) so the event_canceled mode can fire; every other
    // due-check skips cancelled events explicitly.
    cancelled: raw.status === "cancelled",
    calendar
  };
}

// ── Microsoft normalization ─────────────────────────────────────────────────

type GraphEvent = {
  id?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
};

/**
 * Graph start/end → ISO. Graph omits the zone suffix from `dateTime` and
 * reports it in `timeZone` (UTC unless a Prefer header asked otherwise — we
 * never do); anything non-UTC degrades to the raw string rather than lying
 * with a Z suffix.
 */
export function graphTimeIso(t: GraphEvent["start"]): string | undefined {
  if (!t?.dateTime) return undefined;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(t.dateTime)) return t.dateTime;
  return (t.timeZone ?? "UTC") === "UTC" ? `${t.dateTime}Z` : t.dateTime;
}

export function normalizeGraphEvent(
  raw: GraphEvent,
  calendar: CalendarSource
): CalendarEventInput | null {
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    allDay: raw.isAllDay === true,
    title: raw.subject ?? "",
    description: raw.bodyPreview,
    location: raw.location?.displayName,
    organizerEmail: raw.organizer?.emailAddress?.address,
    attendees: (raw.attendees ?? [])
      .map((a) => {
        const addr = a.emailAddress?.address ?? "";
        const name = a.emailAddress?.name ?? "";
        return name && addr ? `${name} <${addr}>` : addr;
      })
      .filter((a) => a.length > 0),
    startIso: graphTimeIso(raw.start),
    endIso: graphTimeIso(raw.end),
    createdIso: raw.createdDateTime,
    updatedIso: raw.lastModifiedDateTime,
    // Kept (not dropped) so the event_canceled mode can fire; every other
    // due-check skips cancelled events explicitly.
    cancelled: raw.isCancelled === true,
    calendar
  };
}

// ── Provider fetchers ───────────────────────────────────────────────────────

const GRAPH_EVENT_SELECT =
  "id,subject,bodyPreview,location,organizer,attendees,start,end,createdDateTime,lastModifiedDateTime,isCancelled,isAllDay";

// calendarView does not support $select on createdDateTime (Graph rejects the
// request); the upcoming query never reads it, so select everything else.
const GRAPH_VIEW_SELECT =
  "id,subject,bodyPreview,location,organizer,attendees,start,end,isCancelled,isAllDay";

/**
 * Graph returns start/end in the event's stored zone unless told otherwise,
 * and a zone-less "2026-07-08T14:00:00" would be misparsed as UTC by
 * Date.parse. This header makes Graph convert every start/end to UTC, so
 * graphTimeIso's Z-suffixing is always correct.
 */
const GRAPH_UTC_HEADERS = { Prefer: 'outlook.timezone="UTC"' };

type CalendarFetch = { events: CalendarEventInput[]; overflowed: boolean };

type FetchTarget = {
  businessId: string;
  link: NangoWorkspaceLink;
  provider: ResolvedVoiceConnection["provider"];
  /** Provider calendar id; null = the account's default/primary calendar. */
  calendarId: string | null;
  source: CalendarSource;
};

/** Events created/updated since the lookback (event_created candidates). */
async function fetchRecentlyCreated(t: FetchTarget, sinceMs: number): Promise<CalendarFetch> {
  const sinceIso = new Date(sinceMs).toISOString();
  if (t.provider === "google") {
    const calId = encodeURIComponent(t.calendarId ?? "primary");
    // updatedMin also returns edited (not new) events; eventCreatedDue's
    // created-timestamp filter narrows those out downstream.
    const res = await nangoProxyForBusiness(t.businessId, t.link, {
      endpoint:
        `/calendar/v3/calendars/${calId}/events?updatedMin=${encodeURIComponent(sinceIso)}` +
        `&maxResults=${CALENDAR_POLL_MAX_EVENTS}&showDeleted=false`,
      method: "GET"
    });
    if (!res) throw new Error("workspace_connection_rejected");
    const items = ((res.data as { items?: GoogleEvent[] })?.items ?? [])
      .map((e) => normalizeGoogleEvent(e, t.source))
      .filter((e): e is CalendarEventInput => e !== null);
    return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
  }
  // /me/calendar/events is the DEFAULT calendar; /me/events would span the
  // whole mailbox (every calendar), mis-tagging secondary-calendar events.
  const base = t.calendarId
    ? `/v1.0/me/calendars/${encodeURIComponent(t.calendarId)}/events`
    : "/v1.0/me/calendar/events";
  const res = await nangoProxyForBusiness(t.businessId, t.link, {
    endpoint:
      `${base}?$filter=${encodeURIComponent(`createdDateTime ge ${sinceIso}`)}` +
      `&$top=${CALENDAR_POLL_MAX_EVENTS}&$select=${GRAPH_EVENT_SELECT}`,
    method: "GET",
    headers: GRAPH_UTC_HEADERS
  });
  if (!res) throw new Error("workspace_connection_rejected");
  const items = ((res.data as { value?: GraphEvent[] })?.value ?? [])
    .map((e) => normalizeGraphEvent(e, t.source))
    .filter((e): e is CalendarEventInput => e !== null);
  return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
}

/**
 * Recently CANCELLED events (event_canceled candidates): everything modified
 * since the lookback, filtered to the cancelled ones. Google surfaces
 * cancellations in the events list only with showDeleted=true (they come
 * back as thin tombstones — id + status, sometimes without a title); Graph
 * keeps declined/cancelled events listed with isCancelled=true until they
 * are hard-deleted, so a hard Graph delete is not observable here.
 */
async function fetchRecentlyCancelled(t: FetchTarget, sinceMs: number): Promise<CalendarFetch> {
  const sinceIso = new Date(sinceMs).toISOString();
  if (t.provider === "google") {
    const calId = encodeURIComponent(t.calendarId ?? "primary");
    const res = await nangoProxyForBusiness(t.businessId, t.link, {
      endpoint:
        `/calendar/v3/calendars/${calId}/events?updatedMin=${encodeURIComponent(sinceIso)}` +
        `&maxResults=${CALENDAR_POLL_MAX_EVENTS}&showDeleted=true`,
      method: "GET"
    });
    if (!res) throw new Error("workspace_connection_rejected");
    const items = ((res.data as { items?: GoogleEvent[] })?.items ?? [])
      .map((e) => normalizeGoogleEvent(e, t.source))
      .filter((e): e is CalendarEventInput => e !== null && e.cancelled === true);
    return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
  }
  const base = t.calendarId
    ? `/v1.0/me/calendars/${encodeURIComponent(t.calendarId)}/events`
    : "/v1.0/me/calendar/events";
  const res = await nangoProxyForBusiness(t.businessId, t.link, {
    endpoint:
      `${base}?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${sinceIso}`)}` +
      `&$top=${CALENDAR_POLL_MAX_EVENTS}&$select=${GRAPH_EVENT_SELECT}`,
    method: "GET",
    headers: GRAPH_UTC_HEADERS
  });
  if (!res) throw new Error("workspace_connection_rejected");
  const items = ((res.data as { value?: GraphEvent[] })?.value ?? [])
    .map((e) => normalizeGraphEvent(e, t.source))
    .filter((e): e is CalendarEventInput => e !== null && e.cancelled === true);
  return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
}

/**
 * Events OVERLAPPING [timeMinMs, timeMaxMs] (both providers use intersection
 * semantics: Google's timeMin/timeMax bound the event's end/start, Graph's
 * calendarView is a range view). Serves both start-mode (window = [now,
 * now + horizon]) and end-mode (window = [now - follow - lookback, now]).
 */
async function fetchOverlapping(
  t: FetchTarget,
  timeMinMs: number,
  timeMaxMs: number
): Promise<CalendarFetch> {
  const timeMin = new Date(timeMinMs).toISOString();
  const timeMax = new Date(timeMaxMs).toISOString();
  if (t.provider === "google") {
    const calId = encodeURIComponent(t.calendarId ?? "primary");
    // singleEvents expands recurrences into occurrence rows, so each
    // occurrence gets its own id + start (and its own dedupe key).
    const res = await nangoProxyForBusiness(t.businessId, t.link, {
      endpoint:
        `/calendar/v3/calendars/${calId}/events?timeMin=${encodeURIComponent(timeMin)}` +
        `&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime` +
        `&maxResults=${CALENDAR_POLL_MAX_EVENTS}`,
      method: "GET"
    });
    if (!res) throw new Error("workspace_connection_rejected");
    const items = ((res.data as { items?: GoogleEvent[] })?.items ?? [])
      .map((e) => normalizeGoogleEvent(e, t.source))
      .filter((e): e is CalendarEventInput => e !== null);
    return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
  }
  const base = t.calendarId
    ? `/v1.0/me/calendars/${encodeURIComponent(t.calendarId)}/calendarView`
    : "/v1.0/me/calendarView";
  const res = await nangoProxyForBusiness(t.businessId, t.link, {
    endpoint:
      `${base}?startDateTime=${encodeURIComponent(timeMin)}` +
      `&endDateTime=${encodeURIComponent(timeMax)}` +
      `&$top=${CALENDAR_POLL_MAX_EVENTS}&$select=${GRAPH_VIEW_SELECT}`,
    method: "GET",
    headers: GRAPH_UTC_HEADERS
  });
  if (!res) throw new Error("workspace_connection_rejected");
  const items = ((res.data as { value?: GraphEvent[] })?.value ?? [])
    .map((e) => normalizeGraphEvent(e, t.source))
    .filter((e): e is CalendarEventInput => e !== null);
  return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
}

// ── Flow listing ────────────────────────────────────────────────────────────

export function calendarFlowsFrom(
  rows: Array<{ id: string; business_id: string; definition: unknown }>
): CalendarFlow[] {
  type RawTrigger = {
    channel?: string;
    calendar?: unknown;
    on?: unknown;
    leadMinutes?: unknown;
    followMinutes?: unknown;
    conditions?: unknown;
  };
  const out: CalendarFlow[] = [];
  for (const row of rows) {
    const def = row.definition as { trigger?: RawTrigger; triggers?: RawTrigger[] } | null;
    // One entry per calendar trigger in the flow's set (OR semantics). The
    // entry `key` stays unique per trigger so the per-poll ref cache never
    // mixes two triggers' saved-contact values; the run dedupe key (flow id +
    // event + mode) still collapses same-event matches into one run.
    const triggers = [def?.trigger, ...(def?.triggers ?? [])];
    for (let ti = 0; ti < triggers.length; ti++) {
      const trig = triggers[ti];
      if (trig?.channel !== "calendar") continue;
      if (
        trig.on !== "event_created" &&
        trig.on !== "event_start" &&
        trig.on !== "event_end" &&
        trig.on !== "event_canceled"
      ) {
        continue;
      }
      const leadMinutes = typeof trig.leadMinutes === "number" ? trig.leadMinutes : 0;
      if (trig.on === "event_start" && typeof trig.leadMinutes !== "number") continue;
      // followMinutes is optional in event_end mode: omitted = fire right at
      // the event's end.
      const followMinutes = typeof trig.followMinutes === "number" ? trig.followMinutes : 0;
      const calendar =
        trig.calendar === "primary" || trig.calendar === "shared" ? trig.calendar : "both";
      out.push({
        key: `${row.id}:${ti}`,
        id: row.id,
        business_id: row.business_id,
        sources: calendar === "both" ? ["primary", "shared"] : [calendar],
        on: trig.on,
        leadMinutes,
        followMinutes,
        conditions: Array.isArray(trig.conditions) ? (trig.conditions as TriggerCondition[]) : []
      });
    }
  }
  return out;
}

// ── Failure logging with escalation ─────────────────────────────────────────

/** True when the failure detail means the connection itself is broken. */
function isConnectionFailure(message: string): boolean {
  return CONNECTION_FAILURE_DETAILS.some((detail) => message.includes(detail));
}

/**
 * Record a poll failure with blip-vs-outage escalation, and alert the OWNER
 * when a connection-class failure persists.
 *
 * - First failure inside the escalation window → `warn` (one-off upstream
 *   blip; stays out of the admin System Errors feed, which is error-only).
 * - Repeat inside the window → `error`.
 * - Third consecutive failing poll with a connection-class detail → one
 *   owner notification per day ("reconnect your calendar"), because a
 *   revoked grant/PAT otherwise stops every calendar-triggered flow with NO
 *   owner-facing signal at all. "Consecutive" is real: the window is sized
 *   to the poll cadence and each business writes at most one failure row per
 *   real poll, so a recovery in between resets the count.
 *
 * All reads/writes are best-effort: log-path trouble degrades toward the
 * old always-error behavior, never toward silence.
 */
async function logCalendarPollFailure(
  db: SupabaseClient,
  businessId: string,
  message: string,
  payload: Record<string, unknown>,
  opts: {
    /**
     * Whether this failure is evidence the CONNECTION is broken (owner-alert
     * eligible). Defaults to the message carrying a connection-class detail;
     * the per-source aggregation passes false when another calendar on the
     * same connection still polled fine — "reconnect your calendar, your
     * automations are paused" must never go out while flows keep firing.
     */
    connectionBroken?: boolean;
  } = {}
): Promise<void> {
  // Failure-path-only lookback: healthy ticks never pay this query.
  let priorFailures = 0;
  let lookbackFailed = false;
  try {
    const sinceIso = new Date(Date.now() - CALENDAR_POLL_FAILURE_ESCALATION_MS).toISOString();
    const { data, error } = await db
      .from("system_logs")
      .select("id")
      .eq("business_id", businessId)
      .eq("event", "ai_flow_calendar_poll_failed")
      .gte("created_at", sinceIso)
      .limit(CALENDAR_POLL_ALERT_PRIOR_FAILURES);
    if (error) throw new Error(error.message);
    priorFailures = (data ?? []).length;
  } catch (err) {
    // Lookback failed — LOG as persistent (error, like before this helper
    // existed) rather than misfiling a real outage as a blip; but never ALERT
    // off an assumed count — the owner ping needs real evidence of three
    // failing polls, not a system_logs read hiccup.
    lookbackFailed = true;
    console.error("calendar poll failure lookback", err);
  }

  const persistent = lookbackFailed || priorFailures >= 1;
  await recordSystemLog({
    businessId,
    source: "aiflow",
    level: persistent ? "error" : "warn",
    event: "ai_flow_calendar_poll_failed",
    message,
    payload
  });

  const connectionBroken = opts.connectionBroken ?? isConnectionFailure(message);
  if (!lookbackFailed && priorFailures >= CALENDAR_POLL_ALERT_PRIOR_FAILURES && connectionBroken) {
    await alertOwnerCalendarBroken(db, businessId);
  }
}

/**
 * Once-per-day owner alert for a persistently broken calendar connection.
 * The dedupe marker is written BEFORE dispatch (at-most-once semantics — an
 * alert storm about an outage would be worse than a lost retry; the outage
 * keeps logging errors either way).
 */
async function alertOwnerCalendarBroken(db: SupabaseClient, businessId: string): Promise<void> {
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data, error } = await db
      .from("system_logs")
      .select("id")
      .eq("business_id", businessId)
      .eq("event", CALENDAR_POLL_OWNER_ALERT_EVENT)
      .gte("created_at", sinceIso)
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) return;

    await recordSystemLog({
      businessId,
      source: "aiflow",
      level: "info",
      event: CALENDAR_POLL_OWNER_ALERT_EVENT,
      message: "Owner alerted: calendar connection persistently failing",
      payload: {}
    });
    await dispatchUrgentNotification({
      businessId,
      kind: "calendar_connection_broken",
      summary: "Your calendar connection stopped working",
      smsBody:
        "New Coworker: your calendar connection stopped working, so calendar-triggered " +
        "automations are paused. Reconnect it on the Integrations page to resume.",
      emailSubject: "Your calendar connection needs to be reconnected",
      emailBody:
        "Your connected calendar stopped accepting our requests, so any automations " +
        "triggered by calendar events are paused until it is reconnected. Open the " +
        "Integrations page in your dashboard and reconnect the calendar to resume.",
      payload: { reason: "calendar_poll_persistent_failure" }
    });
  } catch (err) {
    console.error("calendar poll owner alert", err);
  }
}

// ── Shared enqueue core (poll + pushed webhook events) ─────────────────────

/**
 * Due-check + source + conditions + enqueue for one (flow, event). Returns
 * true when a NEW run was enqueued (false on not-due, source mismatch,
 * unmatched conditions, or the dedupe key already claimed by an earlier
 * observation — the poll and the Vagaro webhook share these keys, so
 * double-observation is a benign no-op).
 */
export async function tryEnqueueCalendarRun(
  db: SupabaseClient,
  businessId: string,
  flow: CalendarFlow,
  ev: CalendarEventInput,
  nowMs: number,
  refValues: Map<string, string[]> | undefined
): Promise<boolean> {
  if (!flow.sources.includes(ev.calendar)) return false;
  if (!flowDueForEvent(flow, ev, nowMs)) return false;
  const scope = calendarTriggerScope(ev);
  if (!evaluateTriggerConditions(flow.conditions, scope.windowText, scope.from, refValues)) {
    return false;
  }
  const run = await enqueueAiFlowRun(
    {
      businessId,
      flowId: flow.id,
      trigger: scope,
      dedupeKey: calendarDedupeKey(flow.on, ev)
    },
    db
  );
  if (!run) return false; // already enqueued by an earlier observation
  await recordSystemLog({
    businessId,
    source: "aiflow",
    level: "info",
    event: "ai_flow_run_enqueued_calendar",
    message:
      flow.on === "event_start"
        ? `Upcoming calendar event "${ev.title}" triggered a run`
        : flow.on === "event_end"
          ? `Completed calendar event "${ev.title}" triggered a run`
          : flow.on === "event_canceled"
            ? `Canceled calendar event "${ev.title}" triggered a run`
            : `New calendar event "${ev.title}" triggered a run`,
    payload: {
      flow_id: flow.id,
      event_id: ev.id,
      calendar: ev.calendar,
      starts_at: ev.startIso ?? null,
      ends_at: ev.endIso ?? null
    }
  });
  return true;
}

/**
 * Fire one business's event_created / event_canceled calendar flows for an
 * event PUSHED by a provider webhook (the Vagaro receiver), in real time —
 * the push-side twin of the poll loop, sharing due-checks, condition
 * evaluation, and dedupe keys, so whichever observer sees the event first
 * wins and the other no-ops. event_start / event_end stay poll-only (they
 * are time-driven, not event-driven). Returns the number of runs enqueued.
 */
export async function fireCalendarTriggersForPushedEvent(
  db: SupabaseClient,
  businessId: string,
  ev: CalendarEventInput,
  nowMs: number
): Promise<number> {
  // Paged like pollCalendarTriggers' listing so a business with more than
  // one page of calendar-capable flows never silently loses the tail
  // (Bugbot on PR #810). A LATER page failing keeps the flows already in
  // hand — the minute poll re-observes with the same dedupe keys.
  const flowRows: Array<{ id: string; business_id: string; definition: unknown }> = [];
  for (let offset = 0; ; offset += CALENDAR_POLL_FLOW_PAGE) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, business_id, definition")
      .eq("business_id", businessId)
      .eq("enabled", true)
      .or("definition->trigger->>channel.eq.calendar,definition->triggers.not.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + CALENDAR_POLL_FLOW_PAGE - 1);
    if (error) {
      if (flowRows.length === 0) {
        throw new Error(`fireCalendarTriggersForPushedEvent: ${error.message}`);
      }
      console.error("fireCalendarTriggersForPushedEvent flow listing page", error.message);
      break;
    }
    const batch = (data ?? []) as typeof flowRows;
    flowRows.push(...batch);
    if (batch.length < CALENDAR_POLL_FLOW_PAGE) break;
  }
  const mode = ev.cancelled ? "event_canceled" : "event_created";
  const flows = calendarFlowsFrom(flowRows).filter((f) => f.on === mode);

  let enqueued = 0;
  for (const flow of flows) {
    // Same per-flow saved-contact ref resolution as the poll (fails CLOSED
    // for that flow only).
    let refValues: Map<string, string[]> | undefined;
    try {
      refValues = await resolveFromMatchesRefValues(
        db as unknown as ContactRefSupabase,
        businessId,
        flow.conditions
      );
    } catch (e) {
      console.error("pushed calendar from_matches ref resolution", e);
      refValues = undefined;
    }
    if (await tryEnqueueCalendarRun(db, businessId, flow, ev, nowMs, refValues)) {
      enqueued += 1;
    }
  }
  return enqueued;
}

// ── Poll cadence gate ───────────────────────────────────────────────────────

/**
 * Should this tick run a REAL poll, or did a recent poll already cover it?
 * Tracked with a platform-level system_logs marker (no new table); the
 * caller stamps the marker AFTER a successful poll (stampCalendarPollTick),
 * so a thrown poll never consumes a cadence slot — the next minute retries.
 * Two racing kicks could both poll — harmless, the run dedupe keys make
 * double polling idempotent; this gate is purely a call-volume optimization.
 * Fails OPEN (poll runs) so gate trouble can never stall calendar triggers.
 */
export async function shouldRunCalendarPoll(client?: SupabaseClient): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  try {
    const sinceIso = new Date(Date.now() - CALENDAR_POLL_MIN_INTERVAL_MS).toISOString();
    const { data, error } = await db
      .from("system_logs")
      .select("id")
      .is("business_id", null)
      .eq("event", CALENDAR_POLL_TICK_EVENT)
      .gte("created_at", sinceIso)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length === 0;
  } catch (err) {
    console.error("shouldRunCalendarPoll", err);
    return true;
  }
}

/** Stamp the cadence marker — call only after a poll actually completed. */
export async function stampCalendarPollTick(client?: SupabaseClient): Promise<void> {
  await recordSystemLog(
    {
      businessId: null,
      source: "aiflow",
      level: "debug",
      event: CALENDAR_POLL_TICK_EVENT,
      message: "Calendar trigger poll tick",
      payload: {}
    },
    client
  );
}

// ── The poll ────────────────────────────────────────────────────────────────

/** Poll every watched calendar once and enqueue runs for due events. */
export async function pollCalendarTriggers(client?: SupabaseClient): Promise<CalendarPollResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const flowRows: Array<{ id: string; business_id: string; definition: unknown }> = [];
  for (let offset = 0; ; offset += CALENDAR_POLL_FLOW_PAGE) {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, business_id, definition")
      .eq("enabled", true)
      .or("definition->trigger->>channel.eq.calendar,definition->triggers.not.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + CALENDAR_POLL_FLOW_PAGE - 1);
    if (error) {
      // Nothing listed yet → surface the failure. A LATER page failing must
      // not discard the flows already in hand — poll those businesses this
      // tick and let the next tick retry the full listing.
      if (flowRows.length === 0) throw new Error(`pollCalendarTriggers: ${error.message}`);
      console.error("pollCalendarTriggers flow listing page", error.message);
      break;
    }
    const batch = (data ?? []) as typeof flowRows;
    flowRows.push(...batch);
    if (batch.length < CALENDAR_POLL_FLOW_PAGE) break;
  }

  const flows = calendarFlowsFrom(flowRows);
  const result: CalendarPollResult = {
    flows: flows.length,
    businesses: 0,
    events: 0,
    enqueued: 0
  };
  if (flows.length === 0) return result;

  // Cadence gate: the worker kicks every minute, but the trigger due-windows
  // tolerate the wider CALENDAR_POLL_MIN_INTERVAL_MS spacing — EXCEPT an
  // event_start flow with a lead at or below the gate threshold, whose due
  // window ([start - lead, start)) could fall entirely between two gated
  // polls. Any such flow keeps the whole poll at per-minute cadence; the
  // flow LISTING above always runs (one cheap query), the gate only saves
  // the provider calls.
  const gateSafe = flows.every(
    (f) => f.on !== "event_start" || f.leadMinutes > CALENDAR_GATE_MIN_START_LEAD_MINUTES
  );
  if (gateSafe && !(await shouldRunCalendarPoll(db))) {
    return { ...result, skipped: true };
  }

  const byBusiness = new Map<string, CalendarFlow[]>();
  for (const f of flows) {
    byBusiness.set(f.business_id, [...(byBusiness.get(f.business_id) ?? []), f]);
  }

  const nowMs = Date.now();
  const createdSinceMs = nowMs - CALENDAR_CREATED_LOOKBACK_MINUTES * 60_000;
  for (const [businessId, group] of byBusiness) {
    result.businesses += 1;
    try {
      const conn = await resolveCalendarConnection(businessId);
      // CalDAV connections have no pollable calendar — not connected for
      // triggers. Calendly and Vagaro ARE pollable (dedicated fetchers
      // below); Google/Microsoft use the Nango fetchers.
      if (
        !conn ||
        (conn.provider !== "calendly" &&
          conn.provider !== "vagaro" &&
          !isWorkspaceCalendarProvider(conn.provider))
      ) {
        throw new Error("calendar_not_connected");
      }

      const eventsBySource = new Map<CalendarSource, CalendarEventInput[]>();

      if (conn.provider === "calendly") {
        // Calendly branch: one "primary" source (no shared-calendar concept
        // on Calendly — shared-only flows quietly see no events). Windows
        // mirror the workspace path; the due filter is the poller's own
        // logic so invitee enrichment is spent only on events that can fire.
        const primaryFlows = group.filter((f) => f.sources.includes("primary"));
        if (primaryFlows.length > 0) {
          const leads = primaryFlows
            .filter((f) => f.on === "event_start")
            .map((f) => f.leadMinutes);
          const follows = primaryFlows
            .filter((f) => f.on === "event_end")
            .map((f) => f.followMinutes);
          const fetched = await fetchCalendlyCandidateEvents({
            businessId,
            conn,
            nowMs,
            windows: {
              createdScan: primaryFlows.some((f) => f.on === "event_created"),
              startHorizonMinutes:
                leads.length > 0
                  ? Math.max(...leads) + CALENDAR_START_HORIZON_BUFFER_MINUTES
                  : null,
              endBackMinutes:
                follows.length > 0
                  ? Math.max(...follows) + CALENDAR_END_LOOKBACK_MINUTES
                  : null,
              canceledScan: primaryFlows.some((f) => f.on === "event_canceled")
            },
            dueFilter: (ev) => primaryFlows.some((f) => flowDueForEvent(f, ev, nowMs))
          });
          if (fetched.overflowed) {
            await recordSystemLog({
              businessId,
              source: "aiflow",
              level: "warn",
              event: "ai_flow_calendar_poll_overflow",
              message:
                "Calendly poll hit a listing/enrichment cap this tick; remainder deferred to later polls",
              payload: { calendar: "primary", events_read: fetched.events.length }
            });
          }
          eventsBySource.set("primary", fetched.events);
          result.events += fetched.events.length;
        }
      } else if (conn.provider === "vagaro") {
        // Vagaro branch: one "primary" source (no shared-calendar concept,
        // Calendly parity). Windows mirror the Calendly path; the due filter
        // keeps only events that can actually fire this tick.
        const primaryFlows = group.filter((f) => f.sources.includes("primary"));
        if (primaryFlows.length > 0) {
          const leads = primaryFlows
            .filter((f) => f.on === "event_start")
            .map((f) => f.leadMinutes);
          const follows = primaryFlows
            .filter((f) => f.on === "event_end")
            .map((f) => f.followMinutes);
          const fetched = await fetchVagaroCandidateEvents({
            businessId,
            nowMs,
            windows: {
              createdScan: primaryFlows.some((f) => f.on === "event_created"),
              startHorizonMinutes:
                leads.length > 0
                  ? Math.max(...leads) + CALENDAR_START_HORIZON_BUFFER_MINUTES
                  : null,
              endBackMinutes:
                follows.length > 0
                  ? Math.max(...follows) + CALENDAR_END_LOOKBACK_MINUTES
                  : null,
              canceledScan: primaryFlows.some((f) => f.on === "event_canceled")
            },
            dueFilter: (ev) => primaryFlows.some((f) => flowDueForEvent(f, ev, nowMs))
          });
          if (fetched.overflowed) {
            await recordSystemLog({
              businessId,
              source: "aiflow",
              level: "warn",
              event: "ai_flow_calendar_poll_overflow",
              message:
                "Vagaro poll hit a listing cap this tick; remainder deferred to later polls",
              payload: { calendar: "primary", events_read: fetched.events.length }
            });
          }
          eventsBySource.set("primary", fetched.events);
          result.events += fetched.events.length;
        }
      } else {
        const link: NangoWorkspaceLink = {
          connectionId: conn.connectionId,
          providerConfigKey: conn.providerConfigKey
        };
        // Read-only lookup — polling must never create the shared calendar. A
        // flow watching only a not-yet-created shared calendar is a quiet no-op.
        const shared = await getSharedCalendar(businessId);

        // One provider query per (source, query kind) regardless of how many
        // flows watch it: created-mode flows share the lookback listing,
        // start-mode flows share one upcoming window sized to the largest lead.
        const targets = new Map<CalendarSource, FetchTarget>();
        for (const source of ["primary", "shared"] as const) {
          if (!group.some((f) => f.sources.includes(source))) continue;
          if (source === "shared" && !shared) continue;
          targets.set(source, {
            businessId,
            link,
            provider: conn.provider,
            calendarId: source === "shared" ? shared!.calendarId : null,
            source
          });
        }

        // Per-source failures aggregate into ONE failure row after the loop:
        // the escalation lookback counts rows as consecutive failing POLLS,
        // so a business watching both calendars must not double-strike in a
        // single poll when one broken link fails both sources.
        const sourceFailures: Array<{ source: CalendarSource; message: string }> = [];
        for (const [source, target] of targets) {
        const collected: CalendarEventInput[] = [];
        const seenIds = new Set<string>();
        const push = (evs: CalendarEventInput[]) => {
          for (const ev of evs) {
            if (seenIds.has(ev.id)) continue;
            seenIds.add(ev.id);
            collected.push(ev);
          }
        };
        let overflowed = false;
        // Per-calendar isolation: one calendar failing (e.g. the shared one
        // was deleted on the provider) must not drop the events already
        // fetched from the other — collect and keep going; dedupe keys make
        // the retry on the next tick benign.
        try {
          if (group.some((f) => f.on === "event_created" && f.sources.includes(source))) {
            const fetched = await fetchRecentlyCreated(target, createdSinceMs);
            push(fetched.events);
            overflowed ||= fetched.overflowed;
          }
          const leads = group
            .filter((f) => f.on === "event_start" && f.sources.includes(source))
            .map((f) => f.leadMinutes);
          if (leads.length > 0) {
            const horizonMinutes = Math.max(...leads) + CALENDAR_START_HORIZON_BUFFER_MINUTES;
            const fetched = await fetchOverlapping(
              target,
              nowMs,
              nowMs + horizonMinutes * 60_000
            );
            push(fetched.events);
            overflowed ||= fetched.overflowed;
          }
          // end-mode flows share one recently-ended window sized to the
          // largest follow delay (plus the due lookback, so an event still
          // inside its firing window is always listed).
          const follows = group
            .filter((f) => f.on === "event_end" && f.sources.includes(source))
            .map((f) => f.followMinutes);
          if (follows.length > 0) {
            const backMinutes = Math.max(...follows) + CALENDAR_END_LOOKBACK_MINUTES;
            const fetched = await fetchOverlapping(target, nowMs - backMinutes * 60_000, nowMs);
            push(fetched.events);
            overflowed ||= fetched.overflowed;
          }
          // canceled-mode flows share one recently-modified listing filtered
          // to cancellations.
          if (group.some((f) => f.on === "event_canceled" && f.sources.includes(source))) {
            const fetched = await fetchRecentlyCancelled(
              target,
              nowMs - CALENDAR_CANCELED_LOOKBACK_MINUTES * 60_000
            );
            push(fetched.events);
            overflowed ||= fetched.overflowed;
          }
        } catch (err) {
          sourceFailures.push({
            source,
            message: err instanceof Error ? err.message : String(err)
          });
        }
        if (overflowed) {
          // A full page means this poll may not have covered every candidate
          // event this tick; the event_start window keeps re-listing until
          // the event starts, so surface it rather than dropping silently.
          await recordSystemLog({
            businessId,
            source: "aiflow",
            level: "warn",
            event: "ai_flow_calendar_poll_overflow",
            message:
              "Calendar poll hit its per-query event cap this tick; remainder deferred to later polls",
            payload: { calendar: source, events_read: collected.length }
          });
        }
        eventsBySource.set(source, collected);
        result.events += collected.length;
        }
        if (sourceFailures.length > 0) {
          const detail = sourceFailures
            .map((f) => `${f.source}: ${f.message}`)
            .join("; ");
          await logCalendarPollFailure(
            db,
            businessId,
            `Calendar-trigger poll failed for ${sourceFailures.length === 1 ? `the ${sourceFailures[0].source} calendar` : "both calendars"}: ${detail}`,
            { calendars: sourceFailures.map((f) => f.source) },
            {
              // Owner-alert eligible only when EVERY polled calendar failed
              // with a connection-class detail — one dead shared calendar
              // beside a healthy primary is not a broken connection, and the
              // "your automations are paused" alert would be false.
              connectionBroken:
                sourceFailures.length === targets.size &&
                sourceFailures.every((f) => isConnectionFailure(f.message))
            }
          );
        }
      }

      // Pre-resolve each flow's from_matches saved-contact refs ONCE for this
      // poll (not per event) to live identity values (phones + emails). A
      // resolution failure fails CLOSED for that flow only.
      const refValuesByFlow = new Map<string, Map<string, string[]> | undefined>();
      for (const flow of group) {
        try {
          // Cast: the full supabase-js builder type recurses too deep for TS
          // to check structurally against the resolver's minimal chain type.
          refValuesByFlow.set(
            flow.key,
            await resolveFromMatchesRefValues(
              db as unknown as ContactRefSupabase,
              businessId,
              flow.conditions
            )
          );
        } catch (e) {
          console.error("calendar from_matches ref resolution", e);
          refValuesByFlow.set(flow.key, undefined);
        }
      }

      for (const flow of group) {
        for (const source of flow.sources) {
          for (const ev of eventsBySource.get(source) ?? []) {
            const enqueued = await tryEnqueueCalendarRun(
              db,
              businessId,
              flow,
              ev,
              nowMs,
              refValuesByFlow.get(flow.key)
            );
            if (enqueued) result.enqueued += 1;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCalendarPollFailure(db, businessId, `Calendar-trigger poll failed: ${message}`, {});
    }
  }
  // Stamp AFTER the poll completed so a thrown listing never consumes a
  // cadence slot. Only stamped when the gate applies — a short-lead
  // deployment polls every minute and would just accumulate unread markers.
  if (gateSafe) await stampCalendarPollTick(db);
  return result;
}
