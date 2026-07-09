import { describe, expect, it } from "vitest";
import {
  timeWindowDecision,
  zonedWeekday
} from "../supabase/functions/_shared/ai_flows/quiet_hours";

// Phoenix never observes DST, so UTC-7 holds year-round — exact-instant
// assertions stay stable no matter when the suite runs.
const PHX = "America/Phoenix";
// 2026-06-09 is a Tuesday (weekday 2).
/** Epoch ms for a Phoenix wall-clock time on 2026-06-09 (UTC-7). */
function phx(hour: number, minute: number): number {
  return Date.UTC(2026, 5, 9, hour + 7, minute, 0);
}

const BUSINESS_HOURS = { timezone: PHX, start: "09:00", end: "17:00" };

describe("zonedWeekday", () => {
  it("resolves the local weekday", () => {
    expect(zonedWeekday(phx(12, 0), PHX)).toBe(2); // Tuesday
    // 20:00 Phoenix Tuesday is 03:00 UTC Wednesday — local day wins.
    expect(zonedWeekday(phx(20, 0), PHX)).toBe(2);
  });

  it("returns null for an invalid zone", () => {
    expect(zonedWeekday(phx(12, 0), "Not/AZone")).toBeNull();
  });
});

describe("timeWindowDecision", () => {
  it("allows inside the window", () => {
    expect(timeWindowDecision(phx(12, 0), BUSINESS_HOURS)).toEqual({ allowed: true });
    expect(timeWindowDecision(phx(9, 0), BUSINESS_HOURS)).toEqual({ allowed: true });
  });

  it("defers before opening to today's start", () => {
    const d = timeWindowDecision(phx(7, 30), BUSINESS_HOURS);
    expect(d).toEqual({ allowed: false, resumeAtMs: phx(9, 0) });
  });

  it("defers after closing to tomorrow's start", () => {
    const d = timeWindowDecision(phx(18, 0), BUSINESS_HOURS);
    expect(d).toEqual({ allowed: false, resumeAtMs: phx(9, 0) + 24 * 60 * 60_000 });
  });

  it("boundary: end minute is outside, start minute is inside", () => {
    expect(timeWindowDecision(phx(17, 0), BUSINESS_HOURS).allowed).toBe(false);
    expect(timeWindowDecision(phx(8, 59), BUSINESS_HOURS).allowed).toBe(false);
  });

  it("skips to the next allowed weekday", () => {
    // Mon-Fri window, checked on Friday 2026-06-12 at 18:00 (after close):
    // Saturday+Sunday are closed, so the resume is Monday 09:00.
    const friday1800 = phx(18, 0) + 3 * 24 * 60 * 60_000;
    const monday0900 = phx(9, 0) + 6 * 24 * 60 * 60_000;
    const d = timeWindowDecision(friday1800, {
      ...BUSINESS_HOURS,
      daysOfWeek: [1, 2, 3, 4, 5]
    });
    expect(d).toEqual({ allowed: false, resumeAtMs: monday0900 });
  });

  it("blocks an in-hours instant on a disallowed day", () => {
    // Tuesday noon, but the window only opens Mondays.
    const d = timeWindowDecision(phx(12, 0), { ...BUSINESS_HOURS, daysOfWeek: [1] });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(zonedWeekday(d.resumeAtMs, PHX)).toBe(1);
    }
  });

  it("supports a cross-midnight window", () => {
    const overnight = { timezone: PHX, start: "21:00", end: "08:30" };
    expect(timeWindowDecision(phx(23, 0), overnight)).toEqual({ allowed: true });
    expect(timeWindowDecision(phx(3, 0), overnight)).toEqual({ allowed: true });
    expect(timeWindowDecision(phx(12, 0), overnight)).toEqual({
      allowed: false,
      resumeAtMs: phx(21, 0)
    });
  });

  it("fails open on bad config", () => {
    expect(timeWindowDecision(phx(3, 0), { timezone: "Not/AZone", start: "09:00", end: "17:00" }))
      .toEqual({ allowed: true });
    expect(timeWindowDecision(phx(3, 0), { timezone: PHX, start: "nope", end: "17:00" })).toEqual({
      allowed: true
    });
    // Zero-length window matches nothing → treated as "no window".
    expect(timeWindowDecision(phx(3, 0), { timezone: PHX, start: "09:00", end: "09:00" })).toEqual(
      { allowed: true }
    );
    // daysOfWeek present but all entries invalid → treated as "no window".
    expect(
      timeWindowDecision(phx(3, 0), { ...BUSINESS_HOURS, daysOfWeek: [99] as unknown as number[] })
    ).toEqual({ allowed: true });
  });
});
