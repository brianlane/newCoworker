/**
 * AiFlows quiet-hours math (pure, no IO).
 *
 * Two features share this module:
 *
 *   - route_to_team `offerWindow`: an agent offer sent during the owner's quiet
 *     window still goes out immediately, but its claim deadline is pushed to
 *     the morning resume time + a grace countdown (e.g. a lead at 2 AM Phoenix
 *     time gives the agent until 8:40 AM, not 2:10 AM).
 *   - send_sms `quietHours`: the LEAD must not be texted during the overnight
 *     window; the worker either emails instead (when the flow extracted a lead
 *     email) or defers the run until the resume time via earliest_claim_at.
 *
 * All wall-clock math uses Intl time-zone formatting (no date libraries), and
 * every helper FAILS OPEN on bad config (invalid tz / malformed HH:MM): a
 * corrupt stored definition must degrade to "no quiet hours" rather than crash
 * the worker or strand a lead.
 */

export type OfferWindowConfig = {
  /** IANA zone the window is defined in, e.g. "America/Phoenix". */
  timezone: string;
  /** Window start, 24h "HH:MM" (e.g. "21:00"). */
  quietStart: string;
  /** Window end / morning resume, 24h "HH:MM" (e.g. "08:30"). */
  quietEnd: string;
  /** Countdown minutes granted after quietEnd. Default 10. */
  graceMinutes?: number;
};

export type SmsQuietHoursConfig = {
  timezone: string;
  /** Last sendable local time, 24h "HH:MM" (e.g. "22:00"). */
  noSendAfter: string;
  /** Morning local time texting resumes, 24h "HH:MM" (e.g. "08:30"). */
  resumeAt: string;
};

export const DEFAULT_OFFER_GRACE_MINUTES = 10;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" → minutes since local midnight, or null when malformed. */
export function parseHHMM(value: string): number | null {
  const m = HHMM_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The local wall-clock time (hours/minutes/seconds) of an instant in an IANA
 * zone, or null when the zone is invalid. Uses Intl so Deno/Node agree and no
 * date library is needed.
 */
export function zonedClock(
  ms: number,
  timeZone: string
): { minutesOfDay: number; seconds: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    /* c8 ignore next -- Intl always emits hour/minute/second parts for a valid zone */
    return part ? Number(part.value) : Number.NaN;
  };
  // Some Intl impls render midnight as "24" with hour12:false; normalize.
  const hour = read("hour") % 24;
  const minute = read("minute");
  const second = read("second");
  /* c8 ignore next -- Intl always yields numeric hour/minute/second for a valid zone */
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) return null;
  return { minutesOfDay: hour * 60 + minute, seconds: second };
}

/**
 * Is `minutesOfDay` inside [start, end)? Supports windows that cross midnight
 * (start > end, e.g. 21:00 → 08:30). A zero-length window (start === end)
 * matches nothing.
 */
export function inDailyWindow(minutesOfDay: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutesOfDay >= startMin && minutesOfDay < endMin;
  return minutesOfDay >= startMin || minutesOfDay < endMin;
}

/**
 * The next instant (>= now) whose local wall-clock time in `timeZone` is
 * `targetMinutes` since midnight, with seconds zeroed. Returns null on invalid
 * zone. Minute-delta arithmetic is exact for fixed-offset zones (Phoenix has
 * no DST) and within an hour around a DST jump elsewhere — fine for a
 * quiet-hours boundary, which is a courtesy line, not a contract.
 */
export function nextTimeOfDayMs(
  nowMs: number,
  timeZone: string,
  targetMinutes: number
): number | null {
  const clock = zonedClock(nowMs, timeZone);
  if (!clock) return null;
  const deltaMin = (targetMinutes - clock.minutesOfDay + 1440) % 1440;
  return nowMs - clock.seconds * 1000 - (nowMs % 1000) + deltaMin * 60_000;
}

/**
 * Absolute claim deadline (epoch ms) for a route_to_team offer sent at `nowMs`.
 * Inside the quiet window the countdown starts at quietEnd, so the deadline is
 * quietEnd + graceMinutes; outside it (or on bad config) it is the normal
 * now + responseMinutes.
 */
export function offerRespondByMs(
  nowMs: number,
  responseMinutes: number,
  window?: OfferWindowConfig
): number {
  const normal = nowMs + responseMinutes * 60_000;
  if (!window) return normal;
  const start = parseHHMM(window.quietStart);
  const end = parseHHMM(window.quietEnd);
  const clock = start !== null && end !== null ? zonedClock(nowMs, window.timezone) : null;
  if (start === null || end === null || !clock) return normal;
  if (!inDailyWindow(clock.minutesOfDay, start, end)) return normal;
  const resume = nextTimeOfDayMs(nowMs, window.timezone, end);
  /* c8 ignore next -- zonedClock succeeded above, so the same zone can't fail here */
  if (resume === null) return normal;
  const grace = window.graceMinutes ?? DEFAULT_OFFER_GRACE_MINUTES;
  return resume + Math.max(0, grace) * 60_000;
}

export type SmsQuietDecision = { allowed: true } | { allowed: false; resumeAtMs: number };

/**
 * May the lead be texted right now? Inside [noSendAfter, resumeAt) the answer
 * is no, with the next resume instant for an earliest_claim_at deferral.
 * Fails open (allowed) on bad config.
 */
export function smsQuietDecision(nowMs: number, cfg: SmsQuietHoursConfig): SmsQuietDecision {
  const start = parseHHMM(cfg.noSendAfter);
  const end = parseHHMM(cfg.resumeAt);
  if (start === null || end === null) return { allowed: true };
  const clock = zonedClock(nowMs, cfg.timezone);
  if (!clock) return { allowed: true };
  if (!inDailyWindow(clock.minutesOfDay, start, end)) return { allowed: true };
  const resumeAtMs = nextTimeOfDayMs(nowMs, cfg.timezone, end);
  /* c8 ignore next -- zonedClock succeeded above, so the same zone can't fail here */
  if (resumeAtMs === null) return { allowed: true };
  return { allowed: false, resumeAtMs };
}

/**
 * Human copy for an instant in the owner's zone, e.g. "8:40 AM on Jun 12" —
 * what `{{offer.deadline}}` renders to inside offer templates. Falls back to
 * the UTC ISO string when the zone is invalid.
 */
export function formatInTimeZone(ms: number, timeZone: string): string {
  try {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).format(new Date(ms));
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric"
    }).format(new Date(ms));
    return `${time} on ${day}`;
  } catch {
    return new Date(ms).toISOString();
  }
}
