/**
 * Current date/time system-preamble line, shared by every coworker surface
 * (SMS worker, dashboard chat route, voice bridge keeps a mirrored copy).
 *
 * Why: no surface told the model the current date, so relative dates
 * ("tomorrow at 2pm", "next Tuesday") could not be resolved into the ISO
 * timestamps the calendar tools require — the model either guessed a year
 * or refused.
 *
 * When the business has a timezone set (IANA name on `businesses.timezone`),
 * the line leads with business-local time so the model resolves "tomorrow"
 * against the owner's/customers' actual day, with the UTC instant included
 * for unambiguous ISO conversion. Without one (or with an invalid name) it
 * falls back to the original UTC-pinned wording.
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
  const weekday = WEEKDAYS[now.getUTCDay()];
  return (
    `Current date/time: ${iso} (${weekday}, UTC). ` +
    `Resolve relative dates like "today", "tomorrow", or "next Tuesday" against this ` +
    `timestamp when calling calendar or scheduling tools, and pass ISO 8601 times.`
  );
}
