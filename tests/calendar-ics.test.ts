/**
 * Tests for the shared iCalendar primitives (src/lib/calendar-tools/ics.ts),
 * extracted from the CalDAV client when the subscription feed needed the
 * same encoding.
 */
import { describe, expect, it } from "vitest";

import {
  buildIcsCalendar,
  escapeICalText,
  foldIcsLine,
  icalUtcStamp
} from "@/lib/calendar-tools/ics";
import {
  escapeICalText as caldavEscape,
  icalUtcStamp as caldavStamp
} from "@/lib/caldav/client";

describe("primitives", () => {
  it("renders the iCal UTC form", () => {
    expect(icalUtcStamp(new Date("2026-07-11T09:00:00.000Z"))).toBe("20260711T090000Z");
  });

  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeICalText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("stays re-exported from the CalDAV client so nothing drifted", () => {
    expect(caldavEscape).toBe(escapeICalText);
    expect(caldavStamp).toBe(icalUtcStamp);
  });

  it("leaves short lines unfolded and folds long ones with a leading space", () => {
    expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short");
    const long = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldIcsLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toHaveLength(74);
    for (const cont of parts.slice(1)) {
      expect(cont.startsWith(" ")).toBe(true);
      expect(cont.length).toBeLessThanOrEqual(74);
    }
    // Unfolding (drop CRLF + one space) recovers the original exactly.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("buildIcsCalendar", () => {
  const EVENT = {
    uid: "row-1@newcoworker",
    summary: "Booking: Sam",
    description: "Booked via voice",
    startIso: "2026-08-05T17:00:00.000Z",
    endIso: "2026-08-05T17:30:00.000Z"
  };

  it("renders a complete publishable calendar", () => {
    const ics = buildIcsCalendar("Shop bookings", [EVENT]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("X-WR-CALNAME:Shop bookings");
    expect(ics).toContain("UID:row-1@newcoworker");
    expect(ics).toContain("DTSTART:20260805T170000Z");
    expect(ics).toContain("DTEND:20260805T173000Z");
    expect(ics).toContain("SUMMARY:Booking: Sam");
    expect(ics).toContain("DESCRIPTION:Booked via voice");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // CRLF throughout, per the RFC.
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it("omits DESCRIPTION when there is none", () => {
    const { description: _drop, ...bare } = EVENT;
    expect(buildIcsCalendar("Cal", [bare])).not.toContain("DESCRIPTION");
  });

  it("skips an event with an unparseable boundary instead of corrupting the feed", () => {
    const ics = buildIcsCalendar("Cal", [
      { ...EVENT, uid: "bad", startIso: "garbage" },
      EVENT
    ]);
    expect(ics).not.toContain("UID:bad");
    expect(ics).toContain("UID:row-1@newcoworker");
  });

  it("renders an empty but valid calendar for no events", () => {
    const ics = buildIcsCalendar("Cal", []);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("escapes the calendar name and event text", () => {
    const ics = buildIcsCalendar("Bagels, etc.", [
      { ...EVENT, summary: "Cut; then color, maybe" }
    ]);
    expect(ics).toContain("X-WR-CALNAME:Bagels\\, etc.");
    expect(ics).toContain("SUMMARY:Cut\\; then color\\, maybe");
  });
});
