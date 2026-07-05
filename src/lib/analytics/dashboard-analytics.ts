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
import type { VoiceCallSentiment } from "@/lib/db/voice-transcripts";

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

export const CALL_SENTIMENT_KEYS: VoiceCallSentiment[] = [
  "positive",
  "neutral",
  "negative",
  "mixed"
];

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
