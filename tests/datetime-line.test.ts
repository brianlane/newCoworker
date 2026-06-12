import { describe, expect, it } from "vitest";
import { currentDateTimeLine } from "../supabase/functions/_shared/datetime_line.ts";
import { currentDateTimeLine as currentDateTimeLineVoice } from "../vps/voice-bridge/src/datetime-line";

describe("currentDateTimeLine", () => {
  it("renders the ISO timestamp, UTC weekday, and tool guidance", () => {
    const line = currentDateTimeLine(new Date("2026-06-11T23:30:00.000Z"));
    expect(line).toContain("Current date/time: 2026-06-11T23:30:00.000Z (Thursday, UTC).");
    expect(line).toContain("ISO 8601");
  });

  it("defaults to now", () => {
    const before = new Date();
    const line = currentDateTimeLine();
    const iso = line.match(/Current date\/time: (\S+) /)?.[1] ?? "";
    const stamp = new Date(iso).getTime();
    expect(Number.isFinite(stamp)).toBe(true);
    expect(Math.abs(stamp - before.getTime())).toBeLessThan(60_000);
  });

  it("voice-bridge mirror stays in sync with the shared edge copy", () => {
    const at = new Date("2026-06-14T08:00:00.000Z");
    expect(currentDateTimeLineVoice(at)).toBe(currentDateTimeLine(at));
    expect(currentDateTimeLineVoice(at)).toContain("(Sunday, UTC)");
  });

  it("renders business-local time when a timezone is provided", () => {
    // 2026-06-11 23:30 UTC = 2026-06-11 16:30 in Phoenix (UTC-7, no DST).
    const line = currentDateTimeLine(new Date("2026-06-11T23:30:00.000Z"), "America/Phoenix");
    expect(line).toContain("Current date/time for this business:");
    expect(line).toContain("Thursday, June 11, 2026");
    expect(line).toContain("4:30");
    expect(line).toContain("timezone: America/Phoenix");
    expect(line).toContain("The UTC instant is 2026-06-11T23:30:00.000Z");
    expect(line).toContain("pass ISO 8601 times and the America/Phoenix timezone");
  });

  it("crosses the date line correctly for late-UTC instants", () => {
    // 23:30 UTC Thursday is already Friday in Tokyo.
    const line = currentDateTimeLine(new Date("2026-06-11T23:30:00.000Z"), "Asia/Tokyo");
    expect(line).toContain("Friday, June 12, 2026");
  });

  it("falls back to the UTC wording for blank or invalid timezones", () => {
    const at = new Date("2026-06-11T23:30:00.000Z");
    const utcLine = currentDateTimeLine(at);
    expect(currentDateTimeLine(at, null)).toBe(utcLine);
    expect(currentDateTimeLine(at, "   ")).toBe(utcLine);
    expect(currentDateTimeLine(at, "Not/AZone")).toBe(utcLine);
  });

  it("voice-bridge mirror stays in sync for timezone rendering too", () => {
    const at = new Date("2026-06-14T08:00:00.000Z");
    expect(currentDateTimeLineVoice(at, "America/New_York")).toBe(
      currentDateTimeLine(at, "America/New_York")
    );
    expect(currentDateTimeLineVoice(at, "bogus")).toBe(currentDateTimeLine(at, "bogus"));
  });
});
