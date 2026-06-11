import { describe, expect, it } from "vitest";
import {
  DAILY_CATCHUP_MINUTES,
  MIN_EVERY_MINUTES,
  scheduleDue,
  zonedDate
} from "../supabase/functions/_shared/ai_flows/schedule";

// Phoenix never observes DST, so UTC-7 holds year-round — exact-instant
// assertions stay stable no matter when the suite runs.
const PHX = "America/Phoenix";
/** Epoch ms for a Phoenix wall-clock time on 2026-06-09 (a Tuesday, UTC-7). */
function phx(hour: number, minute: number, second = 0): number {
  return Date.UTC(2026, 5, 9, hour + 7, minute, second);
}

describe("zonedDate", () => {
  it("returns the local calendar date and weekday", () => {
    // 2026-06-09 02:00 UTC is still 2026-06-08 (Monday) 19:00 in Phoenix.
    expect(zonedDate(Date.UTC(2026, 5, 9, 2, 0, 0), PHX)).toEqual({
      isoDate: "2026-06-08",
      weekday: 1
    });
    expect(zonedDate(phx(12, 0), PHX)).toEqual({ isoDate: "2026-06-09", weekday: 2 });
  });
  it("returns null for an invalid zone", () => {
    expect(zonedDate(phx(12, 0), "Not/AZone")).toBeNull();
  });
});

describe("scheduleDue — daily mode", () => {
  const cfg = { timezone: PHX, time: "08:30" };
  it("is due from the scheduled time through the catch-up window", () => {
    const at = scheduleDue(phx(8, 30, 5), cfg);
    expect(at).not.toBeNull();
    expect(at!.key).toBe("d:2026-06-09T08:30");
    expect(at!.scheduledForIso).toBe(new Date(phx(8, 30)).toISOString());

    const late = scheduleDue(phx(8, 30 + DAILY_CATCHUP_MINUTES - 1, 59), cfg);
    expect(late).not.toBeNull();
    expect(late!.key).toBe("d:2026-06-09T08:30"); // same occurrence → same dedupe key
  });
  it("is not due before the time or after the catch-up window", () => {
    expect(scheduleDue(phx(8, 29, 59), cfg)).toBeNull();
    expect(scheduleDue(phx(8, 30 + DAILY_CATCHUP_MINUTES), cfg)).toBeNull();
  });
  it("respects daysOfWeek (2026-06-09 is a Tuesday = 2)", () => {
    expect(scheduleDue(phx(8, 45), { ...cfg, daysOfWeek: [2] })).not.toBeNull();
    expect(scheduleDue(phx(8, 45), { ...cfg, daysOfWeek: [0, 6] })).toBeNull();
    // An empty list means "every day", same as omitting it.
    expect(scheduleDue(phx(8, 45), { ...cfg, daysOfWeek: [] })).not.toBeNull();
  });
  it("stays due across local midnight for a near-midnight target", () => {
    const nearMidnight = { timezone: PHX, time: "23:30" };
    // 2026-06-10 00:15 Phoenix is 45 minutes past 2026-06-09 23:30 — inside
    // the catch-up window, keyed to the occurrence's (previous) local date.
    const due = scheduleDue(phx(24, 15, 5), nearMidnight);
    expect(due).not.toBeNull();
    expect(due!.key).toBe("d:2026-06-09T23:30");
    expect(due!.scheduledForIso).toBe(new Date(phx(23, 30)).toISOString());
    // ...but not once the window has fully elapsed.
    expect(scheduleDue(phx(24, 30), nearMidnight)).toBeNull();
  });
  it("post-midnight catch-up honors the occurrence day's weekday, not today's", () => {
    const nearMidnight = { timezone: PHX, time: "23:30" };
    // 00:15 Wednesday belongs to Tuesday's 23:30 occurrence (weekday 2).
    expect(scheduleDue(phx(24, 15), { ...nearMidnight, daysOfWeek: [2] })).not.toBeNull();
    expect(scheduleDue(phx(24, 15), { ...nearMidnight, daysOfWeek: [3] })).toBeNull();
  });
  it("an early-morning target is not due just after midnight", () => {
    // 00:10 with an 00:30 target: today's occurrence hasn't happened and
    // yesterday's was a full day ago — neither branch may fire.
    expect(scheduleDue(phx(24, 10), { timezone: PHX, time: "00:30" })).toBeNull();
  });
  it("fails closed on malformed time or zone", () => {
    expect(scheduleDue(phx(8, 45), { timezone: PHX, time: "8:30" })).toBeNull();
    expect(scheduleDue(phx(8, 45), { timezone: "Not/AZone", time: "08:30" })).toBeNull();
    expect(scheduleDue(phx(8, 45), { timezone: PHX })).toBeNull();
    expect(scheduleDue(phx(8, 45), { time: "08:30" })).toBeNull();
  });
});

describe("scheduleDue — interval mode", () => {
  it("buckets the epoch clock into one occurrence per interval", () => {
    const now = Date.UTC(2026, 5, 9, 15, 17, 3);
    const due = scheduleDue(now, { everyMinutes: 60 });
    expect(due).not.toBeNull();
    const bucket = Math.floor(now / 3_600_000);
    expect(due!.key).toBe(`i60:${bucket}`);
    expect(due!.scheduledForIso).toBe(new Date(bucket * 3_600_000).toISOString());
    // Any instant in the same bucket yields the same key (dedupe holds).
    const again = scheduleDue(now + 5 * 60_000, { everyMinutes: 60 });
    expect(again!.key).toBe(due!.key);
  });
  it("clamps everyMinutes to the floor", () => {
    const now = Date.UTC(2026, 5, 9, 15, 0, 0);
    const due = scheduleDue(now, { everyMinutes: 1 });
    expect(due!.key.startsWith(`i${MIN_EVERY_MINUTES}:`)).toBe(true);
  });
  it("interval mode wins over a (corrupt) combined config", () => {
    const due = scheduleDue(phx(3, 0), { everyMinutes: 30, time: "08:30", timezone: PHX });
    expect(due!.key.startsWith("i30:")).toBe(true);
  });
});
