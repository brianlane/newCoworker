/**
 * Read-only aggregations behind /dashboard/analytics (Standard/Enterprise
 * perk, tier relaunch).
 *
 * Everything here is derived from data other features already write:
 *   - `daily_usage`            → per-day call / SMS / voice-minute volume
 *   - `voice_call_transcripts` → peak call hours + caller sentiment mix
 *   - `system_logs`            → refused inbound calls (`voice_call_blocked`,
 *                                written by telnyx-voice-inbound) for the
 *                                answer-rate card
 *
 * No new writers, no cron — the page recomputes on render. Windows are short
 * (30 days) and every query is business-scoped and indexed
 * (idx_daily_usage_biz_date, idx_system_logs_business_created), so a render
 * costs a handful of cheap reads.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";
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

/**
 * Per-day call/SMS/voice-minute series for the trailing window, zero-filled
 * (a day with no usage still gets a point so charts don't skip bars).
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

  const { data, error } = await db
    .from("daily_usage")
    .select("usage_date, calls_made, sms_sent, voice_minutes_used")
    .eq("business_id", businessId)
    .gte("usage_date", startYmd)
    .order("usage_date", { ascending: true });
  if (error) throw new Error(`getDailyUsageSeries: ${error.message}`);

  type Row = {
    usage_date: string;
    calls_made: number | null;
    sms_sent: number | null;
    voice_minutes_used: number | null;
  };
  const byDate = new Map<string, Row>();
  for (const row of (data as Row[] | null) ?? []) {
    byDate.set(row.usage_date, row);
  }

  const series: DailyUsagePoint[] = [];
  const totals = { calls: 0, sms: 0, voiceMinutes: 0 };
  for (let i = 0; i < days; i += 1) {
    const date = utcYmd(new Date(start.getTime() + i * 86_400_000));
    const row = byDate.get(date);
    const point: DailyUsagePoint = {
      date,
      calls: Number(row?.calls_made ?? 0),
      sms: Number(row?.sms_sent ?? 0),
      voiceMinutes: Number(row?.voice_minutes_used ?? 0)
    };
    totals.calls += point.calls;
    totals.sms += point.sms;
    totals.voiceMinutes += point.voiceMinutes;
    series.push(point);
  }
  return { days: series, totals };
}

export const CALL_SENTIMENT_KEYS: VoiceCallSentiment[] = [
  "positive",
  "neutral",
  "negative",
  "mixed"
];

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

/** One call row in the day drill-down, shaped for the analytics page's list. */
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

export type AnalyticsDayDetail = {
  /** UTC calendar date, YYYY-MM-DD (same bucketing as the volume series). */
  date: string;
  usage: { calls: number; sms: number; voiceMinutes: number };
  /** Calls that day, newest first (answered + forwarded; missed excluded like the 30-day cards). */
  calls: DayDetailCall[];
  /** Inbound calls refused that day (concurrency limit / out of minutes). */
  turnedAway: number;
  /** True when the call list hit its row cap and shows only the most recent calls. */
  clipped: boolean;
};

/** Row cap for the day drill-down call list — far above any single tenant's daily volume. */
export const ANALYTICS_DAY_CALL_LIMIT = 200;

/**
 * Everything the analytics page shows when the owner clicks into one day of
 * the 30-day volume charts: that day's usage totals, the individual calls
 * (deep-linking into /dashboard/calls/[id]), and the turned-away count.
 *
 * The day is a UTC calendar date because that's how `daily_usage` buckets —
 * the drill-down must slice transcripts on the same boundary or its call
 * list would disagree with the bar the owner clicked.
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

  type CallRow = {
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
  const CALL_COLUMNS = [
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

  // `voice_call_transcripts` is a residency-moved table: vps-mode tenants
  // read it from their box (like the call-history list). `daily_usage` and
  // `system_logs` are central control-plane tables and always read central.
  const fetchCalls = async (): Promise<CallRow[]> => {
    const vpsReadMode = await isVpsReadMode(businessId, db);
    if (vpsReadMode) {
      return await readMovedRows<CallRow>(businessId, {
        table: "voice_call_transcripts",
        columns: CALL_COLUMNS,
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          // Missed forwarded calls are represented by the turned-away count
          // (their voice_call_blocked ledger row) — same single-bucket rule
          // as the 30-day cards.
          { column: "status", op: "neq", value: "missed" },
          { column: "started_at", op: "gte", value: startIso },
          { column: "started_at", op: "lt", value: endIso }
        ],
        order: [{ column: "started_at", ascending: false }],
        limit: ANALYTICS_DAY_CALL_LIMIT
      });
    }
    const { data, error } = await db
      .from("voice_call_transcripts")
      .select(
        "id, caller_e164, started_at, ended_at, status, direction, call_kind, forwarded_to_e164, summary, sentiment"
      )
      .eq("business_id", businessId)
      .neq("status", "missed")
      .gte("started_at", startIso)
      .lt("started_at", endIso)
      .order("started_at", { ascending: false })
      .limit(ANALYTICS_DAY_CALL_LIMIT);
    if (error) throw new Error(`getAnalyticsDayDetail calls: ${error.message}`);
    return (data as CallRow[] | null) ?? [];
  };

  const [usageRes, callRows, blockedRes] = await Promise.all([
    db
      .from("daily_usage")
      .select("calls_made, sms_sent, voice_minutes_used")
      .eq("business_id", businessId)
      .eq("usage_date", date)
      .maybeSingle(),
    fetchCalls(),
    db
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
  ]);
  if (usageRes.error) throw new Error(`getAnalyticsDayDetail usage: ${usageRes.error.message}`);
  if (blockedRes.error) {
    throw new Error(`getAnalyticsDayDetail blocked: ${blockedRes.error.message}`);
  }

  type UsageRow = {
    calls_made: number | null;
    sms_sent: number | null;
    voice_minutes_used: number | null;
  };
  const usageRow = (usageRes.data as UsageRow | null) ?? null;

  return {
    date,
    usage: {
      calls: Number(usageRow?.calls_made ?? 0),
      sms: Number(usageRow?.sms_sent ?? 0),
      voiceMinutes: Number(usageRow?.voice_minutes_used ?? 0)
    },
    calls: callRows.map((row) => ({
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
    })),
    turnedAway: blockedRes.count ?? 0,
    clipped: callRows.length >= ANALYTICS_DAY_CALL_LIMIT
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

  const [answeredRes, blockedRes] = await Promise.all([
    db
      .from("voice_call_transcripts")
      .select("started_at, sentiment")
      .eq("business_id", businessId)
      .eq("direction", "inbound")
      // A missed forwarded call writes BOTH a status='missed' transcript row
      // (call history) and a voice_call_blocked ledger row (counted below) —
      // exclude it here so the attempt isn't bucketed twice.
      .neq("status", "missed")
      .gte("started_at", cutoffIso)
      .order("started_at", { ascending: false })
      .limit(ANALYTICS_CALL_SCAN_LIMIT),
    db
      .from("system_logs")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(ANALYTICS_CALL_SCAN_LIMIT)
  ]);
  if (answeredRes.error) throw new Error(`getInboundCallStats: ${answeredRes.error.message}`);
  if (blockedRes.error) {
    throw new Error(`getInboundCallStats blocked: ${blockedRes.error.message}`);
  }

  const rows =
    (answeredRes.data as Array<{ started_at: string; sentiment: string | null }> | null) ?? [];
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

  const [{ count: answeredCount, error: answeredErr }, { count: missedCount, error: missedErr }] =
    await Promise.all([
      db
        .from("voice_call_transcripts")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("direction", "inbound")
        // Missed forwarded calls are counted on the `voice_call_blocked` side
        // (telnyx-voice-call-end writes both rows) — excluding them here keeps
        // each attempt in exactly one bucket. Answered forwarded calls count
        // as answered: a human picking up IS an answer.
        .neq("status", "missed")
        .gte("started_at", cutoffIso),
      db
        .from("system_logs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("event", "voice_call_blocked")
        .gte("created_at", cutoffIso)
    ]);
  if (answeredErr) throw new Error(`getAnswerRateStats answered: ${answeredErr.message}`);
  if (missedErr) throw new Error(`getAnswerRateStats missed: ${missedErr.message}`);

  const answered = answeredCount ?? 0;
  const missed = missedCount ?? 0;
  const total = answered + missed;
  return { answered, missed, rate: total === 0 ? null : answered / total };
}
