/**
 * Shared iCalendar (RFC 5545) primitives.
 *
 * `icalUtcStamp` and `escapeICalText` moved here from `@/lib/caldav/client`
 * (which re-exports them, so no call site changed) when the subscribable
 * calendar feed needed the same encoding: two independent copies of iCal
 * escaping is how one of them silently diverges.
 *
 * `buildIcsCalendar` is the feed's whole-calendar assembler. It exists here
 * rather than in the feed module because it is provider-neutral: it renders
 * whatever events it is handed, and the only iCal-specific knowledge in the
 * codebase should live in one file.
 */

/** `2026-07-11T09:00:00.000Z` → `20260711T090000Z` (iCal UTC form). */
export function icalUtcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Escape TEXT values per RFC 5545 (backslash, semicolon, comma, newline). */
export function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line to RFC 5545's 75-octet limit, continuing with
 * CRLF + one space. Folding is byte-based in the RFC; we fold at 74
 * characters, which is safely within the limit for the ASCII-dominant
 * content the feed produces and never splits a UTF-8 code point because
 * JavaScript slices on code units after the escape pass.
 */
export function foldIcsLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) {
    parts.push(` ${line.slice(i, i + 73)}`);
  }
  return parts.join("\r\n");
}

export type IcsEvent = {
  /** Stable per-event identifier, the same booking must keep the same UID
   * across fetches, or subscribing clients duplicate it. */
  uid: string;
  summary: string;
  description?: string;
  startIso: string;
  endIso: string;
};

/**
 * A complete VCALENDAR for a subscription feed.
 *
 * Subscription semantics, deliberately: calendar apps re-download the whole
 * feed and REPLACE their copy with its contents, so an event that stops
 * appearing (a canceled booking, whose ledger row is deleted) simply
 * disappears on the next sync. No SEQUENCE or STATUS:CANCELLED dance is
 * needed, that machinery belongs to iTIP invitations, not feeds.
 *
 * Events with an unparseable start or end are skipped rather than rendered
 * broken: one bad row must not corrupt the whole calendar for every
 * subscriber.
 */
export function buildIcsCalendar(calendarName: string, events: IcsEvent[]): string {
  const now = new Date();
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NewCoworker//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeICalText(calendarName)}`
  ];
  for (const ev of events) {
    const start = new Date(ev.startIso);
    const end = new Date(ev.endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeICalText(ev.uid)}`,
      `DTSTAMP:${icalUtcStamp(now)}`,
      `DTSTART:${icalUtcStamp(start)}`,
      `DTEND:${icalUtcStamp(end)}`,
      `SUMMARY:${escapeICalText(ev.summary)}`,
      ...(ev.description ? [`DESCRIPTION:${escapeICalText(ev.description)}`] : []),
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
