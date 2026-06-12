/**
 * Date awareness for the voice surface. Mirrors
 * `supabase/functions/_shared/datetime_line.ts` (the bridge is rsynced to
 * the VPS standalone, so it can't import across the repo) — keep the two in
 * sync (tests/datetime-line.test.ts asserts equality). Without this the
 * model can't resolve "tomorrow at 2pm" into the ISO times the calendar
 * tools require. Business-local when `businesses.timezone` is set; UTC
 * fallback otherwise.
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

export function currentDateTimeLine(now: Date = new Date(), timeZone?: string | null): string {
  const tz = (timeZone ?? "").trim();
  if (tz) {
    try {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short"
      }).format(now);
      return (
        `Current date/time for this business: ${local} (timezone: ${tz}). ` +
        `The UTC instant is ${now.toISOString()}. ` +
        `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against the ` +
        `business-local time above, and speak to people in their local time. When calling ` +
        `calendar or scheduling tools, pass ISO 8601 times and the ${tz} timezone unless ` +
        `another timezone is explicitly requested.`
      );
    } catch {
      // Invalid IANA name — fall through to the UTC wording below.
    }
  }
  const iso = now.toISOString();
  const weekday = WEEKDAYS_UTC[now.getUTCDay()];
  return (
    `Current date/time: ${iso} (${weekday}, UTC). ` +
    `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against this ` +
    `timestamp when calling calendar or scheduling tools, and pass ISO 8601 times.`
  );
}
