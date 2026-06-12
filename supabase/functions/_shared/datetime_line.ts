/**
 * Current date/time system-preamble line, shared by every coworker surface
 * (SMS worker, dashboard chat route, voice bridge keeps a mirrored copy).
 *
 * Why: no surface told the model the current date, so relative dates
 * ("tomorrow at 2pm", "next Tuesday") could not be resolved into the ISO
 * timestamps the calendar tools require — the model either guessed a year
 * or refused. Businesses don't store a timezone yet, so the line is pinned
 * to UTC with an explicit label; the model is told to surface times in the
 * customer's words rather than convert.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

export function currentDateTimeLine(now: Date = new Date()): string {
  const iso = now.toISOString();
  const weekday = WEEKDAYS[now.getUTCDay()];
  return (
    `Current date/time: ${iso} (${weekday}, UTC). ` +
    `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against this ` +
    `timestamp when calling calendar or scheduling tools, and pass ISO 8601 times.`
  );
}
