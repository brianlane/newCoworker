import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFER_GRACE_MINUTES,
  formatInTimeZone,
  inDailyWindow,
  nextTimeOfDayMs,
  offerRespondByMs,
  parseHHMM,
  smsQuietDecision,
  zonedClock
} from "../supabase/functions/_shared/ai_flows/quiet_hours";

// Phoenix never observes DST, so UTC-7 holds year-round — exact-instant
// assertions below stay stable no matter when the suite runs.
const PHX = "America/Phoenix";
/** Epoch ms for a Phoenix wall-clock time on 2026-06-09 (UTC-7). */
function phx(hour: number, minute: number, second = 0): number {
  return Date.UTC(2026, 5, 9, hour + 7, minute, second);
}

describe("parseHHMM", () => {
  it("parses 24h times to minutes since midnight", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("08:30")).toBe(510);
    expect(parseHHMM(" 22:00 ")).toBe(1320);
    expect(parseHHMM("23:59")).toBe(1439);
  });
  it("rejects malformed values", () => {
    for (const bad of ["24:00", "8:30", "12:60", "noon", "", "12:3"]) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe("zonedClock", () => {
  it("returns local wall-clock minutes + seconds for a valid zone", () => {
    expect(zonedClock(phx(21, 15, 42), PHX)).toEqual({ minutesOfDay: 21 * 60 + 15, seconds: 42 });
  });
  it("handles midnight (some Intl impls render hour 24)", () => {
    expect(zonedClock(phx(0, 0), PHX)).toEqual({ minutesOfDay: 0, seconds: 0 });
  });
  it("returns null for an invalid zone", () => {
    expect(zonedClock(Date.now(), "Not/AZone")).toBeNull();
  });
});

describe("inDailyWindow", () => {
  it("handles a same-day window [start, end)", () => {
    expect(inDailyWindow(600, 540, 1020)).toBe(true);
    expect(inDailyWindow(539, 540, 1020)).toBe(false);
    expect(inDailyWindow(1020, 540, 1020)).toBe(false);
  });
  it("handles a window crossing midnight (21:00 → 08:30)", () => {
    expect(inDailyWindow(22 * 60, 1260, 510)).toBe(true);
    expect(inDailyWindow(2 * 60, 1260, 510)).toBe(true);
    expect(inDailyWindow(510, 1260, 510)).toBe(false);
    expect(inDailyWindow(12 * 60, 1260, 510)).toBe(false);
  });
  it("a zero-length window matches nothing", () => {
    expect(inDailyWindow(510, 510, 510)).toBe(false);
  });
});

describe("nextTimeOfDayMs", () => {
  it("finds a later time the same day, zeroing seconds", () => {
    expect(nextTimeOfDayMs(phx(6, 0, 30), PHX, 510)).toBe(phx(8, 30));
  });
  it("wraps to the next day when the target already passed", () => {
    expect(nextTimeOfDayMs(phx(23, 15), PHX, 510)).toBe(phx(8, 30) + 86_400_000);
  });
  it("returns now (second-aligned) when already exactly at the target", () => {
    expect(nextTimeOfDayMs(phx(8, 30), PHX, 510)).toBe(phx(8, 30));
  });
  it("returns null for an invalid zone", () => {
    expect(nextTimeOfDayMs(Date.now(), "Not/AZone", 510)).toBeNull();
  });
});

describe("offerRespondByMs", () => {
  const window = { timezone: PHX, quietStart: "21:00", quietEnd: "08:30" };
  it("is now + responseMinutes outside the window (and without a window)", () => {
    expect(offerRespondByMs(phx(14, 0), 10)).toBe(phx(14, 10));
    expect(offerRespondByMs(phx(14, 0), 10, window)).toBe(phx(14, 10));
  });
  it("extends to quietEnd + default grace inside the window (late night)", () => {
    expect(offerRespondByMs(phx(23, 0), 10, window)).toBe(phx(8, 30) + 86_400_000 + DEFAULT_OFFER_GRACE_MINUTES * 60_000);
  });
  it("extends to quietEnd + grace the SAME morning (early hours)", () => {
    expect(offerRespondByMs(phx(2, 0), 10, { ...window, graceMinutes: 15 })).toBe(
      phx(8, 45)
    );
  });
  it("clamps a negative grace to zero", () => {
    expect(offerRespondByMs(phx(2, 0), 10, { ...window, graceMinutes: -5 })).toBe(phx(8, 30));
  });
  it("fails open to now + responseMinutes on bad config", () => {
    expect(offerRespondByMs(phx(23, 0), 10, { ...window, quietStart: "9pm" })).toBe(phx(23, 10));
    expect(offerRespondByMs(phx(23, 0), 10, { ...window, quietEnd: "junk" })).toBe(phx(23, 10));
    expect(offerRespondByMs(phx(23, 0), 10, { ...window, timezone: "Not/AZone" })).toBe(
      phx(23, 10)
    );
  });
});

describe("smsQuietDecision", () => {
  const cfg = { timezone: PHX, noSendAfter: "22:00", resumeAt: "08:30" };
  it("allows daytime and evening-before-cutoff sends", () => {
    expect(smsQuietDecision(phx(14, 0), cfg)).toEqual({ allowed: true });
    expect(smsQuietDecision(phx(21, 30), cfg)).toEqual({ allowed: true });
  });
  it("defers a late-night send to the next morning resume time", () => {
    expect(smsQuietDecision(phx(23, 0), cfg)).toEqual({
      allowed: false,
      resumeAtMs: phx(8, 30) + 86_400_000
    });
  });
  it("defers an early-morning send to the SAME morning", () => {
    expect(smsQuietDecision(phx(3, 0), cfg)).toEqual({ allowed: false, resumeAtMs: phx(8, 30) });
  });
  it("allows exactly at the resume boundary", () => {
    expect(smsQuietDecision(phx(8, 30), cfg)).toEqual({ allowed: true });
  });
  it("fails open on bad config", () => {
    expect(smsQuietDecision(phx(23, 0), { ...cfg, noSendAfter: "late" })).toEqual({
      allowed: true
    });
    expect(smsQuietDecision(phx(23, 0), { ...cfg, resumeAt: "early" })).toEqual({ allowed: true });
    expect(smsQuietDecision(phx(23, 0), { ...cfg, timezone: "Not/AZone" })).toEqual({
      allowed: true
    });
  });
});

describe("formatInTimeZone", () => {
  it("renders a human deadline in the owner's zone", () => {
    expect(formatInTimeZone(phx(8, 40), PHX)).toBe("8:40 AM on Jun 9");
  });
  it("falls back to the UTC ISO string on an invalid zone", () => {
    expect(formatInTimeZone(phx(8, 40), "Not/AZone")).toBe(new Date(phx(8, 40)).toISOString());
  });
});
