/**
 * Daily analytics snapshots + activity forecasting (concepts ported from
 * BizBlasts' AnalyticsSnapshot / daily_snapshot_job / RevenueForecastService,
 * with activity counts standing in for revenue — newCoworker holds no tenant
 * payment data).
 *
 * The nightly sweep (pg_cron → Edge `analytics-snapshot-sweep` →
 * /api/internal/analytics-snapshot-sweep) writes one
 * `analytics_daily_snapshots` row per business per UTC day: aggregate call /
 * text / minute counters computed from the same sources as the live cards.
 * Because the rows are counts only (no content), they survive retention
 * pruning and never need residency routing — the long-window trend and the
 * forecast keep working even for tenants whose raw transcripts age out
 * after 30 days.
 *
 * Forecast math mirrors BizBlasts' `forecast_revenue`: trailing mean +
 * least-squares linear trend, plus a coarse anomaly flag when the most
 * recent week runs far off the prior baseline.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ANALYTICS_CALL_SCAN_LIMIT,
  CALL_SENTIMENT_KEYS,
  fetchTranscriptRows
} from "@/lib/analytics/dashboard-analytics";
import { listBusinesses } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";
import type { VoiceCallSentiment, VoiceTranscriptDirection } from "@/lib/db/voice-transcripts";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type DailySnapshot = {
  businessId: string;
  /** UTC calendar day, YYYY-MM-DD. */
  snapshotDate: string;
  calls: number;
  inboundCalls: number;
  voiceMinutes: number;
  smsSent: number;
  missedCalls: number;
  sentiment: Record<VoiceCallSentiment, number>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole seconds between start and end; 0 for in-progress/invalid rows. */
function callSeconds(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / 1000;
}

/**
 * Aggregate one business's activity for one UTC day — same sources and
 * populations as the live analytics cards (transcripts excluding missed,
 * `daily_usage.sms_sent`, `voice_call_blocked` refusals).
 */
export async function computeDailySnapshot(
  businessId: string,
  dateYmd: string,
  opts: { client?: SupabaseClient } = {}
): Promise<DailySnapshot> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const dayStart = new Date(`${dateYmd}T00:00:00.000Z`);
  const startIso = dayStart.toISOString();
  const endIso = new Date(dayStart.getTime() + DAY_MS).toISOString();

  type CallRow = {
    started_at: string;
    ended_at: string | null;
    direction: VoiceTranscriptDirection;
    sentiment: string | null;
  };
  const [callRows, usageRes, blockedRes] = await Promise.all([
    fetchTranscriptRows<CallRow>(businessId, db, {
      columns: ["started_at", "ended_at", "direction", "sentiment"],
      filter: { startIso, endIso },
      limit: ANALYTICS_CALL_SCAN_LIMIT,
      label: "computeDailySnapshot calls"
    }),
    db
      .from("daily_usage")
      .select("sms_sent")
      .eq("business_id", businessId)
      .eq("usage_date", dateYmd)
      .maybeSingle(),
    db
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("event", "voice_call_blocked")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
  ]);
  if (usageRes.error) throw new Error(`computeDailySnapshot sms: ${usageRes.error.message}`);
  if (blockedRes.error) {
    throw new Error(`computeDailySnapshot blocked: ${blockedRes.error.message}`);
  }

  const sentiment: Record<VoiceCallSentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0
  };
  let seconds = 0;
  let inbound = 0;
  for (const row of callRows) {
    seconds += callSeconds(row.started_at, row.ended_at);
    if (row.direction === "inbound") {
      inbound += 1;
      if (row.sentiment && (CALL_SENTIMENT_KEYS as string[]).includes(row.sentiment)) {
        sentiment[row.sentiment as VoiceCallSentiment] += 1;
      }
    }
  }
  return {
    businessId,
    snapshotDate: dateYmd,
    calls: callRows.length,
    inboundCalls: inbound,
    voiceMinutes: Math.round(seconds / 60),
    smsSent: Number((usageRes.data as { sms_sent: number | null } | null)?.sms_sent ?? 0),
    missedCalls: blockedRes.count ?? 0,
    sentiment
  };
}

/** Idempotent write: re-sweeping a day overwrites with fresh counts. */
export async function upsertDailySnapshot(
  snapshot: DailySnapshot,
  opts: { client?: SupabaseClient } = {}
): Promise<void> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("analytics_daily_snapshots").upsert(
    {
      business_id: snapshot.businessId,
      snapshot_date: snapshot.snapshotDate,
      calls: snapshot.calls,
      inbound_calls: snapshot.inboundCalls,
      voice_minutes: snapshot.voiceMinutes,
      sms_sent: snapshot.smsSent,
      missed_calls: snapshot.missedCalls,
      sentiment_positive: snapshot.sentiment.positive,
      sentiment_neutral: snapshot.sentiment.neutral,
      sentiment_negative: snapshot.sentiment.negative,
      sentiment_mixed: snapshot.sentiment.mixed,
      updated_at: new Date().toISOString()
    },
    { onConflict: "business_id,snapshot_date" }
  );
  if (error) throw new Error(`upsertDailySnapshot: ${error.message}`);
}

/** Days (ending yesterday) each nightly sweep recomputes — covers a missed night or late-settling data. */
export const SNAPSHOT_BACKFILL_DAYS = 3;

export type SnapshotSweepResult = {
  businesses: number;
  snapshots: number;
  errors: Array<{ businessId: string; message: string }>;
};

/**
 * Fleet sweep: recompute + upsert the last SNAPSHOT_BACKFILL_DAYS finished
 * UTC days for every business. Per-tenant failures are recorded and the
 * sweep continues; every write is idempotent so tomorrow converges.
 */
export async function runSnapshotSweep(
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<SnapshotSweepResult> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const businesses = await listBusinesses(db);

  const days: string[] = [];
  for (let i = 1; i <= SNAPSHOT_BACKFILL_DAYS; i += 1) {
    days.push(ymd(new Date(now.getTime() - i * DAY_MS)));
  }

  let snapshots = 0;
  const errors: Array<{ businessId: string; message: string }> = [];
  for (const business of businesses) {
    try {
      for (const day of days) {
        const snapshot = await computeDailySnapshot(business.id, day, { client: db });
        await upsertDailySnapshot(snapshot, { client: db });
        snapshots += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ businessId: business.id, message });
      logger.error("analytics-snapshot-sweep: tenant failed; continuing", {
        businessId: business.id,
        error: message
      });
    }
  }
  return { businesses: businesses.length, snapshots, errors };
}

export type SnapshotSeriesPoint = {
  date: string;
  calls: number;
  smsSent: number;
  voiceMinutes: number;
  inboundCalls: number;
  missedCalls: number;
};

export type SnapshotSeries = {
  /** Zero-filled, oldest → newest. */
  points: SnapshotSeriesPoint[];
  /** Days that actually have a snapshot row — gates the trend/forecast UI. */
  coveredDays: number;
};

/**
 * Zero-filled snapshot series for the trailing `days` finished UTC days
 * (ending yesterday — today has no snapshot yet by design).
 */
export async function getSnapshotSeries(
  businessId: string,
  days: number,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<SnapshotSeries> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const end = new Date(`${ymd(new Date(now.getTime() - DAY_MS))}T00:00:00.000Z`);
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const { data, error } = await db
    .from("analytics_daily_snapshots")
    .select("snapshot_date, calls, sms_sent, voice_minutes, inbound_calls, missed_calls")
    .eq("business_id", businessId)
    .gte("snapshot_date", ymd(start))
    .lte("snapshot_date", ymd(end))
    .order("snapshot_date", { ascending: true });
  if (error) throw new Error(`getSnapshotSeries: ${error.message}`);

  type Row = {
    snapshot_date: string;
    calls: number;
    sms_sent: number;
    voice_minutes: number;
    inbound_calls: number;
    missed_calls: number;
  };
  const byDate = new Map<string, Row>();
  for (const row of ((data as Row[] | null) ?? [])) {
    byDate.set(row.snapshot_date, row);
  }
  const series: SnapshotSeriesPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = ymd(new Date(start.getTime() + i * DAY_MS));
    const row = byDate.get(date);
    series.push({
      date,
      calls: row?.calls ?? 0,
      smsSent: row?.sms_sent ?? 0,
      voiceMinutes: row?.voice_minutes ?? 0,
      inboundCalls: row?.inbound_calls ?? 0,
      missedCalls: row?.missed_calls ?? 0
    });
  }
  return { points: series, coveredDays: byDate.size };
}

// ---------------------------------------------------------------------------
// Forecast (BizBlasts forecast_revenue math on activity counts)
// ---------------------------------------------------------------------------

/** Minimum history before a forecast is worth showing. */
export const FORECAST_MIN_DAYS = 14;

export type ActivityForecast = {
  /** Trailing daily mean. */
  dailyAverage: number;
  /** Least-squares slope (units per day). */
  trendPerDay: number;
  /** Trend-extrapolated total for the next 30 days (never negative). */
  projected30d: number;
  direction: "up" | "down" | "stable";
  /** Last-7-days total far off the prior baseline; null = nothing unusual. */
  anomaly: "quiet" | "busy" | null;
};

/**
 * Mean + least-squares trend over a daily series (oldest first), projected
 * 30 days out. Returns null below FORECAST_MIN_DAYS of history — a trend
 * line through a few points is noise dressed up as insight.
 */
export function forecastActivity(values: number[]): ActivityForecast | null {
  const n = values.length;
  if (n < FORECAST_MIN_DAYS) return null;

  const mean = values.reduce((s, v) => s + v, 0) / n;
  // Least squares over x = 0..n-1. With n ≥ FORECAST_MIN_DAYS the
  // denominator is always positive.
  const xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xMean) * (values[i] - mean);
    den += (i - xMean) * (i - xMean);
  }
  const slope = num / den;

  // Extrapolate from the fitted end of the series, clamped at zero per day.
  const fittedEnd = mean + slope * (n - 1 - xMean);
  let projected = 0;
  for (let i = 1; i <= 30; i += 1) {
    projected += Math.max(0, fittedEnd + slope * i);
  }

  const swing30 = slope * 30;
  const threshold = Math.max(1, mean * 30 * 0.05);
  const direction = swing30 > threshold ? "up" : swing30 < -threshold ? "down" : "stable";

  // Coarse anomaly: the most recent week vs the average prior week, only
  // when the baseline is loud enough for the ratio to mean anything.
  const lastWeek = values.slice(-7).reduce((s, v) => s + v, 0);
  const prior = values.slice(0, -7);
  const priorWeekAvg = (prior.reduce((s, v) => s + v, 0) / prior.length) * 7;
  let anomaly: ActivityForecast["anomaly"] = null;
  if (priorWeekAvg >= 5) {
    if (lastWeek < priorWeekAvg * 0.6) anomaly = "quiet";
    else if (lastWeek > priorWeekAvg * 1.4) anomaly = "busy";
  }

  return {
    dailyAverage: Math.round(mean * 10) / 10,
    trendPerDay: Math.round(slope * 100) / 100,
    projected30d: Math.round(projected),
    direction,
    anomaly
  };
}
