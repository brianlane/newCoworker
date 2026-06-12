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
});
