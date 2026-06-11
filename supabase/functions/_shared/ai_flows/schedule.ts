/**
 * AiFlows schedule-trigger math (pure, no IO).
 *
 * The ai-flow-worker's cron tick calls `scheduleDue` for every enabled flow
 * whose trigger channel is "schedule"; a non-null result is enqueued as a run
 * with dedupe_key = `sched:<occurrence key>`, so the per-(flow, dedupe_key)
 * unique index makes the enqueue exactly-once no matter how many ticks land
 * inside the due window or how late the cron fires.
 *
 * Two modes (exactly one is configured, enforced by the authoring schema):
 *   - daily: `time` ("HH:MM") in `timezone`, optionally limited to
 *     `daysOfWeek` (0=Sunday..6=Saturday). Due for DAILY_CATCHUP_MINUTES
 *     after the wall-clock time passes, so up to an hour of cron downtime
 *     still triggers that day's run (the occurrence key is the local date).
 *   - interval: `everyMinutes`. Each interval bucket of the epoch clock is
 *     one occurrence.
 *
 * Unlike quiet-hours (which fail OPEN so a corrupt config degrades to "no
 * quiet hours"), schedule helpers fail CLOSED: a malformed time/zone yields
 * null ("not due") — failing open here would enqueue a run on every tick.
 */
import { parseHHMM, zonedClock } from "./quiet_hours.ts";

export type ScheduleConfig = {
  timezone?: string;
  /** Daily wall-clock time, 24h "HH:MM". */
  time?: string;
  /** Days `time` applies (0=Sun..6=Sat). Default: every day. */
  daysOfWeek?: number[];
  /** Interval mode: run every N minutes. */
  everyMinutes?: number;
};

export type ScheduleOccurrence = {
  /** Stable per-occurrence key (goes into the run's dedupe_key). */
  key: string;
  /** The occurrence instant, ISO — lands in {{trigger}} context for audit. */
  scheduledForIso: string;
};

/** How long after the daily wall-clock time a missed tick may still fire. */
export const DAILY_CATCHUP_MINUTES = 60;

/** Floor for interval mode — the worker tick itself is only ~1/minute. */
export const MIN_EVERY_MINUTES = 15;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

/** Local calendar date + weekday of an instant in a zone, or null when invalid. */
export function zonedDate(
  ms: number,
  timeZone: string
): { isoDate: string; weekday: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  /* c8 ignore next -- Intl always emits the requested parts for a valid zone */
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[read("weekday")];
  const isoDate = `${read("year")}-${read("month")}-${read("day")}`;
  /* c8 ignore next -- Intl always emits these parts for a valid zone */
  if (weekday === undefined || isoDate.length !== 10) return null;
  return { isoDate, weekday };
}

/**
 * Is this schedule due at `nowMs`? Returns the occurrence (key + instant) or
 * null. Interval mode wins when both are somehow present (the schema forbids
 * that, but a corrupt row must still resolve deterministically).
 */
export function scheduleDue(nowMs: number, cfg: ScheduleConfig): ScheduleOccurrence | null {
  if (typeof cfg.everyMinutes === "number" && Number.isFinite(cfg.everyMinutes)) {
    const every = Math.max(MIN_EVERY_MINUTES, Math.floor(cfg.everyMinutes));
    const bucketMs = every * 60_000;
    const bucket = Math.floor(nowMs / bucketMs);
    return {
      key: `i${every}:${bucket}`,
      scheduledForIso: new Date(bucket * bucketMs).toISOString()
    };
  }
  if (typeof cfg.time !== "string" || typeof cfg.timezone !== "string") return null;
  const targetMin = parseHHMM(cfg.time);
  if (targetMin === null) return null;
  const clock = zonedClock(nowMs, cfg.timezone);
  const date = zonedDate(nowMs, cfg.timezone);
  if (!clock || !date) return null;
  if (Array.isArray(cfg.daysOfWeek) && cfg.daysOfWeek.length > 0) {
    if (!cfg.daysOfWeek.includes(date.weekday)) return null;
  }
  const sinceTarget = clock.minutesOfDay - targetMin;
  if (sinceTarget < 0 || sinceTarget >= DAILY_CATCHUP_MINUTES) return null;
  const occurrenceMs = nowMs - sinceTarget * 60_000 - clock.seconds * 1000 - (nowMs % 1000);
  return {
    key: `d:${date.isoDate}T${cfg.time}`,
    scheduledForIso: new Date(occurrenceMs).toISOString()
  };
}
