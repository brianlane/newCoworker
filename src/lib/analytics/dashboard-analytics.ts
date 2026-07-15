/**
 * Read-only aggregations behind /dashboard/analytics (Standard/Enterprise
 * perk, tier relaunch).
 *
 * Everything here is derived from data other features already write:
 *   - `voice_call_transcripts` → per-day call + voice-minute volume, peak
 *                                call hours, caller sentiment mix, and the
 *                                drill-down call lists. NOT daily_usage:
 *                                its calls_made / voice_minutes_used columns
 *                                have no live writer (voice billing settles
 *                                into voice_settlements), so reading them
 *                                rendered permanent zeros.
 *   - `daily_usage`            → per-day TEXT volume (`sms_sent` is written
 *                                by the SMS reserve functions)
 *   - `sms_inbound_jobs` +
 *     `sms_outbound_log`       → the day drill-down's text list
 *   - `system_logs`            → refused inbound calls (`voice_call_blocked`,
 *                                written by telnyx-voice-inbound) for the
 *                                answer-rate card
 *
 * No new writers, no cron — the page recomputes on render. Windows are short
 * (30 days) and every query is business-scoped and indexed
 * (idx_daily_usage_biz_date, idx_system_logs_business_created), so a render
 * costs a handful of cheap reads.
 *
 * Residency: `voice_call_transcripts` and `sms_outbound_log` are moved
 * tables — every read of them here routes through the residency layer so
 * vps-mode tenants read their box. `daily_usage`, `system_logs`, and
 * `sms_inbound_jobs` are central control-plane/engine tables.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows, isVpsReadMode, readMovedRows } from "@/lib/residency/read";
import type { DataApiFilter } from "@/lib/residency/contract";
import {
  customerE164FromPayload,
  inboundTextFromPayload,
  outboundReplyFromRow,
  type OutboundLogSource
} from "@/lib/db/sms-history";
import type {
  VoiceCallKind,
  VoiceCallSentiment,
  VoiceTranscriptDirection,
  VoiceTranscriptStatus
} from "@/lib/db/voice-transcripts";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Default trailing window for every card on the analytics page. */
export const ANALYTICS_WINDOW_DAYS = 30;

/**
 * Row cap when scanning transcript start times for the peak-hours histogram
 * and sentiment mix. 2000 calls in 30 days is ~65/day — far beyond our
 * current tenants; if a business ever exceeds it the histogram degrades to
 * "most recent 2000 calls", which is still representative.
 */
export const ANALYTICS_CALL_SCAN_LIMIT = 2000;

export type DailyUsagePoint = {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  calls: number;
  sms: number;
  voiceMinutes: number;
};

export type DailyUsageSeries = {
  /** Oldest → newest, zero-filled so charts render a bar per day. */
  days: DailyUsagePoint[];
  totals: { calls: number; sms: number; voiceMinutes: number };
  /** True when the transcript scan hit its row cap — calls/minutes undercount. */
  clipped: boolean;
};

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Start of the trailing window: midnight UTC of the day (days - 1) ago, so a
 * 30-day window covers 30 inclusive UTC calendar days ending today. Every
 * card on the analytics page uses this same boundary — the volume series,
 * the answer rate, and the peak-hours histogram must describe the same
 * interval or the page contradicts itself.
 */
export function analyticsWindowStart(now: Date, days: number): Date {
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  return new Date(`${utcYmd(start)}T00:00:00.000Z`);
}

export const CALL_SENTIMENT_KEYS: VoiceCallSentiment[] = [
  "positive",
  "neutral",
  "negative",
  "mixed"
];

/**
 * Shared transcript-scan filter. Every analytics read of
 * `voice_call_transcripts` excludes `status = 'missed'` (missed forwarded
 * calls live on the `voice_call_blocked` ledger side so each attempt lands
 * in exactly one bucket) and windows on `started_at`.
 */
export type TranscriptFilter = {
  startIso: string;
  /** Exclusive end; omitted = open-ended (trailing window). */
  endIso?: string;
  direction?: VoiceTranscriptDirection;
  sentiment?: VoiceCallSentiment;
};

/**
 * Residency-routed transcript scan: vps-mode tenants read their box (same
 * routing as the call-history list), everyone else reads central. Newest
 * first, capped at `limit`. Exported for the snapshot sweep
 * (src/lib/analytics/snapshots.ts), which aggregates the same population.
 */
export async function fetchTranscriptRows<T>(
  businessId: string,
  db: SupabaseClient,
  opts: { columns: string[]; filter: TranscriptFilter; limit: number; label: string }
): Promise<T[]> {
  const { columns, filter, limit, label } = opts;
  const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const filters: DataApiFilter[] = [
      { column: "business_id", op: "eq", value: businessId },
      { column: "status", op: "neq", value: "missed" },
      { column: "deleted_at", op: "is", value: null },
      { column: "started_at", op: "gte", value: filter.startIso }
    ];
    if (filter.endIso) filters.push({ column: "started_at", op: "lt", value: filter.endIso });
    if (filter.direction) filters.push({ column: "direction", op: "eq", value: filter.direction });
    if (filter.sentiment) filters.push({ column: "sentiment", op: "eq", value: filter.sentiment });
    return await readMovedRows<T>(businessId, {
      table: "voice_call_transcripts",
      columns,
      filters,
      order: [{ column: "started_at", ascending: false }],
      limit
    });
  }
  let q = db
    .from("voice_call_transcripts")
    .select(columns.join(", "))
    .eq("business_id", businessId)
    .neq("status", "missed")
    .is("deleted_at", null)
    .gte("started_at", filter.startIso);
  if (filter.endIso) q = q.lt("started_at", filter.endIso);
  if (filter.direction) q = q.eq("direction", filter.direction);
  if (filter.sentiment) q = q.eq("sentiment", filter.sentiment);
  const { data, error } = await q.order("started_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`${label}: ${error.message}`);
  return ((data as unknown as T[] | null) ?? []) as T[];
}

/** Whole seconds between a call's start and end; 0 for in-progress/invalid rows. */
function callSeconds(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 1000;
}

/**
 * Per-day call/SMS/voice-minute series for the trailing window, zero-filled
 * (a day with no usage still gets a point so charts don't skip bars).
 *
 * Calls and voice minutes are derived from `voice_call_transcripts`
 * (answered + forwarded, both directions; missed excluded) because
 * `daily_usage.calls_made` / `voice_minutes_used` have no live writer —
 * reading them rendered permanent zeros next to real calls. Texts stay on
 * `daily_usage.sms_sent`, which the SMS reserve functions do write. Voice
 * minutes are wall-clock call durations rounded per day — an activity
 * measure, not the billing ledger.
 */
export async function getDailyUsageSeries(
  businessId: string,
  opts: { days?: number; client?: SupabaseClient; now?: Date } = {}
): Promise<DailyUsageSeries> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const start = analyticsWindowStart(now, days);
  const startYmd = utcYmd(start);

  type CallRow = { started_at: string; ended_at: string | null };
  const [smsRes, callRows] = await Promise.all([
    db
      .from("daily_usage")
      .select("usage_date, sms_sent")
      .eq("business_id", businessId)
      .gte("usage_date", startYmd)
      .order("usage_date", { ascending: true }),
    fetchTranscriptRows<CallRow>(businessId, db, {
      columns: ["started_at", "ended_at"],
      filter: { startIso: start.toISOString() },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getDailyUsageSeries calls"
    })
  ]);
  if (smsRes.error) throw new Error(`getDailyUsageSeries: ${smsRes.error.message}`);

  type SmsRow = { usage_date: string; sms_sent: number | null };
  const smsByDate = new Map<string, number>();
  for (const row of (smsRes.data as SmsRow[] | null) ?? []) {
    smsByDate.set(row.usage_date, Number(row.sms_sent ?? 0));
  }

  const callsByDate = new Map<string, number>();
  const secondsByDate = new Map<string, number>();
  for (const row of callRows) {
    const date = utcYmd(new Date(row.started_at));
    callsByDate.set(date, (callsByDate.get(date) ?? 0) + 1);
    secondsByDate.set(
      date,
      (secondsByDate.get(date) ?? 0) + callSeconds(row.started_at, row.ended_at)
    );
  }

  const series: DailyUsagePoint[] = [];
  const totals = { calls: 0, sms: 0, voiceMinutes: 0 };
  for (let i = 0; i < days; i += 1) {
    const date = utcYmd(new Date(start.getTime() + i * 86_400_000));
    const point: DailyUsagePoint = {
      date,
      calls: callsByDate.get(date) ?? 0,
      sms: smsByDate.get(date) ?? 0,
      voiceMinutes: Math.round((secondsByDate.get(date) ?? 0) / 60)
    };
    totals.calls += point.calls;
    totals.sms += point.sms;
    totals.voiceMinutes += point.voiceMinutes;
    series.push(point);
  }
  return { days: series, totals, clipped: callRows.length >= ANALYTICS_CALL_SCAN_LIMIT };
}

/**
 * Strict YYYY-MM-DD guard for the drill-down query param (rejects garbage
 * before it reaches queries). The round-trip check catches impossible
 * calendar dates like 2026-02-31, which V8 silently rolls over to March.
 */
export function isValidAnalyticsDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcYmd(parsed) === value;
}

/** One call row in the drill-down lists, shaped for the analytics page. */
export type DayDetailCall = {
  /** Transcript row UUID — links into /dashboard/calls/[id]. */
  id: string;
  callerE164: string | null;
  startedAt: string;
  endedAt: string | null;
  status: VoiceTranscriptStatus;
  direction: VoiceTranscriptDirection;
  callKind: VoiceCallKind;
  /** For forwarded calls: the human number the call was sent to. */
  forwardedTo: string | null;
  summary: string | null;
  sentiment: VoiceCallSentiment | null;
};

/** Full transcript projection behind every drill-down call list. */
const DETAIL_CALL_COLUMNS = [
  "id",
  "caller_e164",
  "started_at",
  "ended_at",
  "status",
  "direction",
  "call_kind",
  "forwarded_to_e164",
  "summary",
  "sentiment"
];

type DetailCallRow = {
  id: string;
  caller_e164: string | null;
  started_at: string;
  ended_at: string | null;
  status: VoiceTranscriptStatus;
  direction: VoiceTranscriptDirection;
  call_kind: VoiceCallKind;
  forwarded_to_e164: string | null;
  summary: string | null;
  sentiment: string | null;
};

function toDayDetailCall(row: DetailCallRow): DayDetailCall {
  return {
    id: row.id,
    callerE164: row.caller_e164,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    direction: row.direction,
    callKind: row.call_kind,
    forwardedTo: row.forwarded_to_e164,
    summary: row.summary,
    sentiment:
      row.sentiment && (CALL_SENTIMENT_KEYS as string[]).includes(row.sentiment)
        ? (row.sentiment as VoiceCallSentiment)
        : null
  };
}

/** One text message in the day drill-down. */
export type DayDetailText = {
  /** Synthetic id, unique within the day (job/log row id + direction). */
  id: string;
  direction: "inbound" | "outbound";
  /** Customer-side number — links into /dashboard/messages/[e164]. */
  otherE164: string | null;
  content: string;
  timestamp: string;
  /** Set for worker-initiated sends (AiFlow etc.). */
  source?: OutboundLogSource;
  channel: "sms" | "rcs";
};

export type AnalyticsDayDetail = {
  /** UTC calendar date, YYYY-MM-DD (same bucketing as the volume series). */
  date: string;
  usage: { calls: number; sms: number; voiceMinutes: number };
  /** Calls that day, newest first (answered + forwarded; missed excluded like the 30-day cards). */
  calls: DayDetailCall[];
  /** Texts that day (inbound + outbound), newest first. */
  texts: DayDetailText[];
  /** Inbound calls refused that day (concurrency limit / out of minutes). */
  turnedAway: number;
  /** True when the call list hit its row cap and shows only the most recent calls. */
  clipped: boolean;
  /** True when the text list hit its row cap and shows only the most recent texts. */
  textsClipped: boolean;
};

/** Display cap for the day drill-down call list — far above any single tenant's daily volume. */
export const ANALYTICS_DAY_CALL_LIMIT = 200;

/** Display cap for the day drill-down text list. */
export const ANALYTICS_DAY_TEXT_LIMIT = 200;

/**
 * Row cap for the day drill-down's TEXT source scans (inbound jobs and the
 * outbound log, each). Higher than the display cap so `textsClipped` can be
 * detected honestly: a source scan that fills its cap means messages may be
 * missing even when the merged display list sits under its own cap.
 */
export const ANALYTICS_DAY_TEXT_SCAN_LIMIT = 1000;

/**
 * Everything the analytics page shows when the owner clicks into one day of
 * the 30-day volume charts: that day's totals, the individual calls
 * (deep-linking into /dashboard/calls/[id]), the individual texts
 * (deep-linking into /dashboard/messages/[e164]), and the turned-away count.
 *
 * The day is a UTC calendar date because that's how the volume series
 * buckets — the drill-down must slice on the same boundary or its lists
 * would disagree with the bar the owner clicked. Day totals for calls and
 * voice minutes are derived from the fetched transcripts (same source as
 * the series); the text total stays on `daily_usage.sms_sent` (metered
 * sends), while the text LIST also includes inbound messages.
 */
export async function getAnalyticsDayDetail(
  businessId: string,
  date: string,
  opts: { client?: SupabaseClient } = {}
): Promise<AnalyticsDayDetail> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const startIso = dayStart.toISOString();
  const endIso = new Date(dayStart.getTime() + 86_400_000).toISOString();

  // `sms_outbound_log` is a residency-moved table (worker-initiated sends);
  // `sms_inbound_jobs` is an ENGINE table and always reads central — same
  // split as the Text history pages.
  const fetchOutboundLog = async (): Promise<DayTextLogRow[]> => {
    const vpsReadMode = await isVpsReadMode(businessId, db);
    if (vpsReadMode) {
      return await readMovedRows<DayTextLogRow>(businessId, {
        table: "sms_outbound_log",
        columns: ["id", "to_e164", "body", "source", "channel", "created_at"],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "deleted_at", op: "is", value: null },
          { column: "created_at", op: "gte", value: startIso },
          { column: "created_at", op: "lt", value: endIso }
        ],
        order: [{ column: "created_at", ascending: false }],
        limit: ANALYTICS_DAY_TEXT_SCAN_LIMIT
      });
    }
    const { data, error } = await db
      .from("sms_outbound_log")
      .select("id, to_e164, body, source, channel, created_at")
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: false })
      .limit(ANALYTICS_DAY_TEXT_SCAN_LIMIT);
    if (error) throw new Error(`getAnalyticsDayDetail outbound texts: ${error.message}`);
    return (data as DayTextLogRow[] | null) ?? [];
  };

  const [usageRes, callRows, blockedRes, jobsRes, outboundLogRows] = await Promise.all([
    db
      .from("daily_usage")
      .select("sms_sent")
      .eq("business_id", businessId)
      .eq("usage_date", date)
      .maybeSingle(),
    // Scanned at the same row cap as the 30-day series so the header totals
    // agree with the chart bar the owner clicked; only the first
    // ANALYTICS_DAY_CALL_LIMIT rows are rendered in the list.
    fetchTranscriptRows<DetailCallRow>(businessId, db, {
      columns: DETAIL_CALL_COLUMNS,
      filter: { startIso, endIso },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getAnalyticsDayDetail calls"
    }),
    db
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", startIso)
      .lt("created_at", endIso),
    // Jobs created up to a day BEFORE the window still matter: their
    // outbound reply (stamped at updated_at) can land inside this day.
    // Individual messages are re-filtered to the day below.
    db
      .from("sms_inbound_jobs")
      .select(
        "id, payload, status, assistant_reply_text, rowboat_reply_cached, channel, reply_channel, created_at, updated_at"
      )
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .gte("created_at", new Date(dayStart.getTime() - 86_400_000).toISOString())
      .lt("created_at", endIso)
      .order("created_at", { ascending: false })
      .limit(ANALYTICS_DAY_TEXT_SCAN_LIMIT),
    fetchOutboundLog()
  ]);
  if (usageRes.error) throw new Error(`getAnalyticsDayDetail usage: ${usageRes.error.message}`);
  if (blockedRes.error) {
    throw new Error(`getAnalyticsDayDetail blocked: ${blockedRes.error.message}`);
  }
  if (jobsRes.error) throw new Error(`getAnalyticsDayDetail texts: ${jobsRes.error.message}`);

  const usageRow = (usageRes.data as { sms_sent: number | null } | null) ?? null;
  const daySeconds = callRows.reduce(
    (sum, row) => sum + callSeconds(row.started_at, row.ended_at),
    0
  );

  // Expand inbound jobs into per-direction messages (the job row IS the
  // conversational unit — same model as the Text history pages), keep the
  // ones whose own timestamp falls inside the day, then fold in the
  // worker-initiated sends. Numeric comparison — PostgREST may format
  // timestamps as `+00:00` rather than `Z`, which breaks string ordering
  // against the ISO day boundary at exact midnight.
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + 86_400_000;
  const inDay = (ts: string) => {
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= dayStartMs && t < dayEndMs;
  };
  const jobRows = (jobsRes.data as unknown as DayTextJobRow[] | null) ?? [];
  const texts: DayDetailText[] = [];
  for (const row of jobRows) {
    const otherE164 = customerE164FromPayload(row.payload);
    const inboundText = inboundTextFromPayload(row.payload);
    if (inboundText && inDay(row.created_at)) {
      texts.push({
        id: `${row.id}:inbound`,
        direction: "inbound",
        otherE164,
        content: inboundText,
        timestamp: row.created_at,
        channel: row.channel === "rcs" ? "rcs" : "sms"
      });
    }
    const outboundText = outboundReplyFromRow(row);
    const outboundTs = row.updated_at || row.created_at;
    if (outboundText && inDay(outboundTs)) {
      texts.push({
        id: `${row.id}:outbound`,
        direction: "outbound",
        otherE164,
        content: outboundText,
        timestamp: outboundTs,
        channel: row.reply_channel === "rcs" ? "rcs" : "sms"
      });
    }
  }
  for (const row of outboundLogRows) {
    texts.push({
      id: `${row.id}:flow-outbound`,
      direction: "outbound",
      otherE164: row.to_e164,
      content: row.body,
      timestamp: row.created_at,
      source: row.source,
      channel: row.channel === "rcs" ? "rcs" : "sms"
    });
  }
  texts.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  // Clipped when either source scan filled its own row cap (messages may be
  // missing even if the merged list is short) OR the merged list exceeds
  // the display cap.
  const textsClipped =
    jobRows.length >= ANALYTICS_DAY_TEXT_SCAN_LIMIT ||
    outboundLogRows.length >= ANALYTICS_DAY_TEXT_SCAN_LIMIT ||
    texts.length > ANALYTICS_DAY_TEXT_LIMIT;

  return {
    date,
    usage: {
      calls: callRows.length,
      sms: Number(usageRow?.sms_sent ?? 0),
      voiceMinutes: Math.round(daySeconds / 60)
    },
    calls: callRows.slice(0, ANALYTICS_DAY_CALL_LIMIT).map(toDayDetailCall),
    texts: texts.slice(0, ANALYTICS_DAY_TEXT_LIMIT),
    turnedAway: blockedRes.count ?? 0,
    // A scan-cap hit (2000) always exceeds the display cap (200), so one
    // comparison covers both "list truncated" and "totals undercount".
    clipped: callRows.length > ANALYTICS_DAY_CALL_LIMIT,
    textsClipped
  };
}

type DayTextJobRow = {
  id: string;
  payload: Record<string, unknown>;
  status: string;
  assistant_reply_text: string | null;
  rowboat_reply_cached: string | null;
  channel: "sms" | "rcs" | null;
  reply_channel: "sms" | "rcs" | null;
  created_at: string;
  updated_at: string | null;
};

type DayTextLogRow = {
  id: string;
  to_e164: string;
  body: string;
  source: OutboundLogSource;
  channel: "sms" | "rcs" | null;
  created_at: string;
};

/** Calls in the trailing window matching one drill-down segment. */
export type CallSegmentDetail = {
  calls: DayDetailCall[];
  /** True when the list hit its row cap — most recent calls only. */
  clipped: boolean;
};

/** Row cap for the sentiment / peak-hour drill-down call lists. */
export const ANALYTICS_SEGMENT_CALL_LIMIT = 200;

/**
 * Drill-down behind the caller-sentiment card: every summarized inbound
 * call in the window with the given sentiment, newest first — "what made
 * all the calls Neutral" is answered by their AI summaries.
 */
export async function getSentimentCallsDetail(
  businessId: string,
  sentiment: VoiceCallSentiment,
  opts: { days?: number; client?: SupabaseClient; now?: Date } = {}
): Promise<CallSegmentDetail> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const rows = await fetchTranscriptRows<DetailCallRow>(businessId, db, {
    columns: DETAIL_CALL_COLUMNS,
    // Same population as the sentiment mix: inbound calls only.
    filter: {
      startIso: analyticsWindowStart(now, days).toISOString(),
      direction: "inbound",
      sentiment
    },
    limit: ANALYTICS_SEGMENT_CALL_LIMIT,
    label: "getSentimentCallsDetail"
  });
  return {
    calls: rows.map(toDayDetailCall),
    clipped: rows.length >= ANALYTICS_SEGMENT_CALL_LIMIT
  };
}

/**
 * Drill-down behind the peak-hours histogram: the window's answered calls
 * whose local start time falls in the given hour-of-day (business
 * timezone, matching the histogram's bucketing), plus how many turned-away
 * attempts landed in that hour.
 *
 * The hour filter can't run in SQL (bucketing is timezone-dependent), so
 * this scans the window like the histogram does and filters in JS — same
 * cost, same row cap, same clipping semantics.
 */
export async function getHourCallsDetail(
  businessId: string,
  hour: number,
  opts: {
    days?: number;
    timeZone?: string | null;
    client?: SupabaseClient;
    now?: Date;
  } = {}
): Promise<CallSegmentDetail & { turnedAway: number }> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const cutoffIso = analyticsWindowStart(now, days).toISOString();

  const [rows, blockedRes] = await Promise.all([
    fetchTranscriptRows<DetailCallRow>(businessId, db, {
      columns: DETAIL_CALL_COLUMNS,
      // The histogram counts inbound attempts only.
      filter: { startIso: cutoffIso, direction: "inbound" },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getHourCallsDetail"
    }),
    db
      .from("system_logs")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(ANALYTICS_CALL_SCAN_LIMIT)
  ]);
  if (blockedRes.error) {
    throw new Error(`getHourCallsDetail blocked: ${blockedRes.error.message}`);
  }

  const inHour = rows.filter((row) => hourInTimeZone(row.started_at, opts.timeZone) === hour);
  const blocked = (blockedRes.data as Array<{ created_at: string }> | null) ?? [];
  const turnedAway = blocked.filter(
    (row) => hourInTimeZone(row.created_at, opts.timeZone) === hour
  ).length;

  return {
    calls: inHour.slice(0, ANALYTICS_SEGMENT_CALL_LIMIT).map(toDayDetailCall),
    turnedAway,
    clipped:
      inHour.length > ANALYTICS_SEGMENT_CALL_LIMIT ||
      rows.length >= ANALYTICS_CALL_SCAN_LIMIT ||
      blocked.length >= ANALYTICS_CALL_SCAN_LIMIT
  };
}

/**
 * Hour-of-day (0-23) for an ISO timestamp in the business's IANA timezone.
 * Peak hours only make sense on the owner's clock — a plumber in Phoenix
 * cares about "9am rush", not "16:00 UTC". Falls back to UTC when the
 * timezone is missing or the runtime can't format it.
 */
export function hourInTimeZone(iso: string, timeZone: string | null | undefined): number {
  const date = new Date(iso);
  if (timeZone) {
    try {
      const hour = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        hourCycle: "h23"
      }).format(date);
      return Number.parseInt(hour, 10);
    } catch {
      // Unknown/invalid IANA name → UTC fallback below.
    }
  }
  return date.getUTCHours();
}

export type InboundCallStats = {
  /** Inbound call attempts per hour-of-day (24 buckets) in the given timezone. */
  hourBuckets: number[];
  /** Inbound attempts in the histogram: answered + turned away (≤ 2 × scan limit). */
  callCount: number;
  /**
   * True when either scan hit ANALYTICS_CALL_SCAN_LIMIT — the histogram then
   * describes the most recent attempts rather than the whole window, and the
   * UI must say so (the answer-rate card uses exact, uncapped counts, so the
   * two cards' totals can legitimately differ at that volume).
   */
  clipped: boolean;
  /** Sentiment mix across summarized calls in the window (perk3 output). */
  sentiment: Record<VoiceCallSentiment, number>;
  sentimentTotal: number;
};

/**
 * One scan of the window's inbound activity feeds two cards: the peak-hours
 * histogram and the caller-sentiment mix.
 *
 * The histogram counts every inbound ATTEMPT — answered calls (transcript
 * rows) plus turned-away calls (`voice_call_blocked` system_logs rows) —
 * because "when do people call" is exactly the question refused calls answer
 * loudest: a tenant whose morning rush is mostly refusals would otherwise see
 * an empty histogram next to an answer-rate card reporting the misses.
 */
export async function getInboundCallStats(
  businessId: string,
  opts: {
    days?: number;
    /** Business IANA timezone (businesses.timezone); UTC fallback. */
    timeZone?: string | null;
    client?: SupabaseClient;
    now?: Date;
  } = {}
): Promise<InboundCallStats> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const cutoffIso = analyticsWindowStart(now, days).toISOString();

  const [rows, blockedRes] = await Promise.all([
    // A missed forwarded call writes BOTH a status='missed' transcript row
    // (call history) and a voice_call_blocked ledger row (counted below) —
    // the shared scan excludes it so the attempt isn't bucketed twice.
    fetchTranscriptRows<{ started_at: string; sentiment: string | null }>(businessId, db, {
      columns: ["started_at", "sentiment"],
      filter: { startIso: cutoffIso, direction: "inbound" },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getInboundCallStats"
    }),
    db
      .from("system_logs")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(ANALYTICS_CALL_SCAN_LIMIT)
  ]);
  if (blockedRes.error) {
    throw new Error(`getInboundCallStats blocked: ${blockedRes.error.message}`);
  }

  const blocked = (blockedRes.data as Array<{ created_at: string }> | null) ?? [];
  const hourBuckets = new Array<number>(24).fill(0);
  const sentiment: Record<VoiceCallSentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0
  };
  let sentimentTotal = 0;
  for (const row of rows) {
    hourBuckets[hourInTimeZone(row.started_at, opts.timeZone)] += 1;
    if (row.sentiment && (CALL_SENTIMENT_KEYS as string[]).includes(row.sentiment)) {
      sentiment[row.sentiment as VoiceCallSentiment] += 1;
      sentimentTotal += 1;
    }
  }
  for (const row of blocked) {
    hourBuckets[hourInTimeZone(row.created_at, opts.timeZone)] += 1;
  }
  return {
    hourBuckets,
    callCount: rows.length + blocked.length,
    clipped:
      rows.length >= ANALYTICS_CALL_SCAN_LIMIT || blocked.length >= ANALYTICS_CALL_SCAN_LIMIT,
    sentiment,
    sentimentTotal
  };
}

// ---------------------------------------------------------------------------
// Period-over-period comparison (ported from BizBlasts' DashboardService
// period_comparison / calculate_change)
// ---------------------------------------------------------------------------

export type PeriodChange = {
  current: number;
  previous: number;
  /** Signed % change vs the prior window; null when the baseline is 0. */
  percent: number | null;
  direction: "up" | "down" | "flat";
};

/** Delta of one metric vs the prior window, rounded to one decimal. */
export function computePeriodChange(current: number, previous: number): PeriodChange {
  const direction = current > previous ? "up" : current < previous ? "down" : "flat";
  const percent =
    previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10;
  return { current, previous, percent, direction };
}

export type PreviousPeriodTotals = {
  /** Answered calls, both directions (same population as the volume series). */
  calls: number;
  sms: number;
  voiceMinutes: number;
  /** Inbound answered (same population as the answer-rate card). */
  answered: number;
  /** Inbound refused (`voice_call_blocked`). */
  missed: number;
  /** answered / (answered + missed); null when the prior window had no calls. */
  answerRate: number | null;
  /** True when the transcript scan hit its row cap — totals undercount. */
  clipped: boolean;
};

/**
 * Totals for the PRIOR window of the same length ([2·days ago, days ago)),
 * feeding the "vs prior period" deltas next to the current cards. Same
 * sources and semantics as the current-window fetchers: transcripts for
 * calls/minutes (residency-routed, missed excluded), `daily_usage.sms_sent`
 * for texts, `voice_call_blocked` system_logs for refusals. Unlike the
 * answer-rate card's exact counts, `answered` here derives from the capped
 * scan — `clipped` says when that matters.
 */
export async function getPreviousPeriodTotals(
  businessId: string,
  opts: { days?: number; client?: SupabaseClient; now?: Date } = {}
): Promise<PreviousPeriodTotals> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const currStart = analyticsWindowStart(now, days);
  const prevStart = analyticsWindowStart(now, 2 * days);
  const prevStartIso = prevStart.toISOString();
  const currStartIso = currStart.toISOString();

  type CallRow = {
    started_at: string;
    ended_at: string | null;
    direction: VoiceTranscriptDirection;
  };
  const [smsRes, callRows, blockedRes] = await Promise.all([
    db
      .from("daily_usage")
      .select("sms_sent")
      .eq("business_id", businessId)
      .gte("usage_date", utcYmd(prevStart))
      .lt("usage_date", utcYmd(currStart)),
    fetchTranscriptRows<CallRow>(businessId, db, {
      columns: ["started_at", "ended_at", "direction"],
      filter: { startIso: prevStartIso, endIso: currStartIso },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "getPreviousPeriodTotals calls"
    }),
    db
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", prevStartIso)
      .lt("created_at", currStartIso)
  ]);
  if (smsRes.error) throw new Error(`getPreviousPeriodTotals sms: ${smsRes.error.message}`);
  if (blockedRes.error) {
    throw new Error(`getPreviousPeriodTotals blocked: ${blockedRes.error.message}`);
  }

  const sms = ((smsRes.data as Array<{ sms_sent: number | null }> | null) ?? []).reduce(
    (sum, row) => sum + Number(row.sms_sent ?? 0),
    0
  );
  // Minutes are rounded PER DAY and then summed — the exact aggregation the
  // current-window series total uses — so the delta never disagrees with the
  // card purely over rounding.
  const secondsByDate = new Map<string, number>();
  let answered = 0;
  for (const row of callRows) {
    const date = utcYmd(new Date(row.started_at));
    secondsByDate.set(
      date,
      (secondsByDate.get(date) ?? 0) + callSeconds(row.started_at, row.ended_at)
    );
    if (row.direction === "inbound") answered += 1;
  }
  let voiceMinutes = 0;
  for (const daySeconds of secondsByDate.values()) {
    voiceMinutes += Math.round(daySeconds / 60);
  }
  const missed = blockedRes.count ?? 0;
  const inboundTotal = answered + missed;
  const clipped = callRows.length >= ANALYTICS_CALL_SCAN_LIMIT;
  return {
    calls: callRows.length,
    sms,
    voiceMinutes,
    answered,
    missed,
    // A capped scan undercounts `answered` while `missed` stays exact, which
    // would SKEW the rate rather than merely shrink it — suppress the rate
    // (and therefore the delta line) instead of showing a wrong one.
    answerRate: clipped || inboundTotal === 0 ? null : answered / inboundTotal,
    clipped
  };
}

export type AnswerRateStats = {
  /** Inbound calls the AI actually took (a transcript row exists). */
  answered: number;
  /** Inbound calls refused (concurrency limit / out of minutes). */
  missed: number;
  /** answered / (answered + missed); null when there were no calls at all. */
  rate: number | null;
};

/**
 * Answer rate over the window. "Missed" is every inbound call
 * telnyx-voice-inbound refused before opening the AI bridge — it writes a
 * `voice_call_blocked` system_logs row on both refusal reasons
 * (concurrent_limit and quota_exhausted), which makes system_logs the
 * complete refusal ledger (missed_call_autotexts is NOT: it's tier-gated,
 * toggleable, and deduped per caller-hour).
 */
export async function getAnswerRateStats(
  businessId: string,
  opts: { days?: number; client?: SupabaseClient; now?: Date } = {}
): Promise<AnswerRateStats> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const days = opts.days ?? ANALYTICS_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const cutoffIso = analyticsWindowStart(now, days).toISOString();

  // Missed forwarded calls are counted on the `voice_call_blocked` side
  // (telnyx-voice-call-end writes both rows) — excluding them here keeps
  // each attempt in exactly one bucket. Answered forwarded calls count
  // as answered: a human picking up IS an answer. The transcript count is
  // residency-routed (moved table); the refusal ledger is central.
  const countAnswered = async (): Promise<number> => {
    const vpsReadMode = await isVpsReadMode(businessId, db);
    if (vpsReadMode) {
      return await countMovedRows(businessId, {
        table: "voice_call_transcripts",
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "direction", op: "eq", value: "inbound" },
          { column: "status", op: "neq", value: "missed" },
          { column: "deleted_at", op: "is", value: null },
          { column: "started_at", op: "gte", value: cutoffIso }
        ]
      });
    }
    const { count, error } = await db
      .from("voice_call_transcripts")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("direction", "inbound")
      .neq("status", "missed")
      .is("deleted_at", null)
      .gte("started_at", cutoffIso);
    if (error) throw new Error(`getAnswerRateStats answered: ${error.message}`);
    return count ?? 0;
  };

  const [answered, { count: missedCount, error: missedErr }] = await Promise.all([
    countAnswered(),
    db
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", cutoffIso)
  ]);
  if (missedErr) throw new Error(`getAnswerRateStats missed: ${missedErr.message}`);

  const missed = missedCount ?? 0;
  const total = answered + missed;
  return { answered, missed, rate: total === 0 ? null : answered / total };
}
