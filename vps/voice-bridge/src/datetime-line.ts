/**
 * Date awareness for the voice surface. Mirrors
 * `supabase/functions/_shared/datetime_line.ts` (the bridge is rsynced to
 * the VPS standalone, so it can't import across the repo) — keep the two in
 * sync (tests/datetime-line.test.ts asserts equality). Without this the
 * model can't resolve "tomorrow at 2pm" into the ISO times the calendar
 * tools require. UTC-pinned: businesses don't store a timezone yet.
 *
 * Kept dependency-free in its own module so repo-root tests and typecheck
 * can import it without pulling the bridge's runtime deps (@google/genai,
 * ws) that are only installed on the VPS.
 */

const WEEKDAYS_UTC = [
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
  const weekday = WEEKDAYS_UTC[now.getUTCDay()];
  return (
    `Current date/time: ${iso} (${weekday}, UTC). ` +
    `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against this ` +
    `timestamp when calling calendar or scheduling tools, and pass ISO 8601 times.`
  );
}
