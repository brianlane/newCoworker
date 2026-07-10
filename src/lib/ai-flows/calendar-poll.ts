/**
 * Calendar-event trigger poller.
 *
 * Driven by /api/internal/aiflow-calendar-poll (which the ai-flow-worker's
 * cron tick kicks ~1/min, alongside the email poll): finds every ENABLED flow
 * whose trigger channel is "calendar", reads the watched calendar(s) through
 * the business's connected calendar account (resolved Google-first exactly
 * like the calendar tools — no connectionId lives in the trigger), evaluates
 * the flow's conditions over the event text, and enqueues a queued
 * ai_flow_run per match.
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
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import {
  calendarTriggerScope,
  evaluateTriggerConditions,
  type CalendarEventInput
} from "@/lib/ai-flows/trigger-eval";
import { recordSystemLog } from "@/lib/db/system-logs";
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

type CalendarSource = "primary" | "shared";

type CalendarFlow = {
  /** Unique per (flow, trigger index) — one flow can carry several calendar triggers. */
  key: string;
  id: string;
  business_id: string;
  /** Which calendar(s) the flow watches ("both" expands to primary+shared). */
  sources: CalendarSource[];
  on: "event_created" | "event_start" | "event_end";
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
};

/** Whether an event_start flow is due for `ev` at `nowMs` (pure, for tests). */
export function eventStartDue(
  ev: Pick<CalendarEventInput, "startIso" | "allDay">,
  leadMinutes: number,
  nowMs: number
): boolean {
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
  ev: Pick<CalendarEventInput, "endIso" | "allDay">,
  followMinutes: number,
  nowMs: number
): boolean {
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
  ev: Pick<CalendarEventInput, "createdIso">,
  nowMs: number
): boolean {
  if (!ev.createdIso) return false;
  const createdMs = Date.parse(ev.createdIso);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs >= nowMs - CALENDAR_CREATED_LOOKBACK_MINUTES * 60_000;
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
  if (typeof raw.id !== "string" || raw.status === "cancelled") return null;
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
  if (typeof raw.id !== "string" || raw.isCancelled === true) return null;
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
    calendar
  };
}

// ── Provider fetchers ───────────────────────────────────────────────────────

const GRAPH_EVENT_SELECT =
  "id,subject,bodyPreview,location,organizer,attendees,start,end,createdDateTime,isCancelled,isAllDay";

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
    if (!res) throw new Error("calendar_not_connected");
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
  if (!res) throw new Error("calendar_not_connected");
  const items = ((res.data as { value?: GraphEvent[] })?.value ?? [])
    .map((e) => normalizeGraphEvent(e, t.source))
    .filter((e): e is CalendarEventInput => e !== null);
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
    if (!res) throw new Error("calendar_not_connected");
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
  if (!res) throw new Error("calendar_not_connected");
  const items = ((res.data as { value?: GraphEvent[] })?.value ?? [])
    .map((e) => normalizeGraphEvent(e, t.source))
    .filter((e): e is CalendarEventInput => e !== null);
  return { events: items, overflowed: items.length >= CALENDAR_POLL_MAX_EVENTS };
}

// ── Flow listing ────────────────────────────────────────────────────────────

function calendarFlowsFrom(
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
      if (trig.on !== "event_created" && trig.on !== "event_start" && trig.on !== "event_end") {
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
      if (!conn) throw new Error("calendar_not_connected");
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

      const eventsBySource = new Map<CalendarSource, CalendarEventInput[]>();
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
        // fetched from the other — log and keep going; dedupe keys make the
        // retry on the next tick benign.
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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordSystemLog({
            businessId,
            source: "aiflow",
            level: "error",
            event: "ai_flow_calendar_poll_failed",
            message: `Calendar-trigger poll failed for the ${source} calendar: ${message}`,
            payload: { calendar: source }
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
            const due =
              flow.on === "event_start"
                ? eventStartDue(ev, flow.leadMinutes, nowMs)
                : flow.on === "event_end"
                  ? eventEndDue(ev, flow.followMinutes, nowMs)
                  : eventCreatedDue(ev, nowMs);
            if (!due) continue;
            const scope = calendarTriggerScope(ev);
            if (
              !evaluateTriggerConditions(
                flow.conditions,
                scope.windowText,
                scope.from,
                refValuesByFlow.get(flow.key)
              )
            )
              continue;
            const run = await enqueueAiFlowRun(
              {
                businessId,
                flowId: flow.id,
                trigger: scope,
                dedupeKey: calendarDedupeKey(flow.on, ev)
              },
              db
            );
            if (!run) continue; // already enqueued by an earlier tick
            result.enqueued += 1;
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
                    : `New calendar event "${ev.title}" triggered a run`,
              payload: {
                flow_id: flow.id,
                event_id: ev.id,
                calendar: ev.calendar,
                starts_at: ev.startIso ?? null,
                ends_at: ev.endIso ?? null
              }
            });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordSystemLog({
        businessId,
        source: "aiflow",
        level: "error",
        event: "ai_flow_calendar_poll_failed",
        message: `Calendar-trigger poll failed: ${message}`,
        payload: {}
      });
    }
  }
  return result;
}
