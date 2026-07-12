import { describe, expect, it } from "vitest";
import {
  formatScheduleText,
  normalizeWeeklyWindowsJson,
  parseScheduleText
} from "../src/lib/employees/schedule-text";

/**
 * Coverage for src/lib/employees/schedule-text.ts — the human text ⇄ jsonb
 * round-trip behind the Employees page schedule fields. Parsing is strict
 * (typos error in the form, never silently bench an employee); formatting
 * groups consecutive identical days back into ranges.
 */

describe("parseScheduleText", () => {
  it("treats blank input as 'no schedule' (null)", () => {
    expect(parseScheduleText("")).toEqual({ ok: true, value: null });
    expect(parseScheduleText("   ")).toEqual({ ok: true, value: null });
  });

  it("parses a single day with one window", () => {
    expect(parseScheduleText("mon 09:00-17:00")).toEqual({
      ok: true,
      value: { mon: [["09:00", "17:00"]] }
    });
  });

  it("expands day ranges and zero-pads loose times", () => {
    expect(parseScheduleText("mon-wed 9:00-17:30")).toEqual({
      ok: true,
      value: {
        mon: [["09:00", "17:30"]],
        tue: [["09:00", "17:30"]],
        wed: [["09:00", "17:30"]]
      }
    });
  });

  it("supports day lists, full day names, mixed case, and multiple windows", () => {
    expect(parseScheduleText("Monday,WED 9:00-12:00, 13:00-17:00")).toEqual({
      ok: true,
      value: {
        mon: [["09:00", "12:00"], ["13:00", "17:00"]],
        wed: [["09:00", "12:00"], ["13:00", "17:00"]]
      }
    });
  });

  it("combines multiple ;-separated groups, accumulating windows per day", () => {
    expect(parseScheduleText("mon-fri 09:00-17:00; sat 10:00-14:00; mon 18:00-20:00")).toEqual({
      ok: true,
      value: {
        mon: [["09:00", "17:00"], ["18:00", "20:00"]],
        tue: [["09:00", "17:00"]],
        wed: [["09:00", "17:00"]],
        thu: [["09:00", "17:00"]],
        fri: [["09:00", "17:00"]],
        sat: [["10:00", "14:00"]]
      }
    });
  });

  it("ignores empty groups from stray semicolons", () => {
    expect(parseScheduleText(";mon 09:00-17:00;;")).toEqual({
      ok: true,
      value: { mon: [["09:00", "17:00"]] }
    });
  });

  it("treats semicolons-only input as 'no schedule' (null)", () => {
    expect(parseScheduleText(";;")).toEqual({ ok: true, value: null });
  });

  it("supports mixing a range and a single day in one day spec", () => {
    expect(parseScheduleText("mon-tue,thu 09:00-10:00")).toEqual({
      ok: true,
      value: {
        mon: [["09:00", "10:00"]],
        tue: [["09:00", "10:00"]],
        thu: [["09:00", "10:00"]]
      }
    });
  });

  it("errors on a group with no hours", () => {
    const r = parseScheduleText("mon-fri");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("needs days and hours");
  });

  it("errors on unknown day tokens and malformed ranges", () => {
    expect(parseScheduleText("funday 09:00-17:00").ok).toBe(false);
    expect(parseScheduleText("mon-funday 09:00-17:00").ok).toBe(false);
    expect(parseScheduleText("fri-mon 09:00-17:00").ok).toBe(false); // wrap-around not supported
    expect(parseScheduleText("mon-tue-wed 09:00-17:00").ok).toBe(false);
    expect(parseScheduleText("mon,,tue 09:00-17:00").ok).toBe(false);
  });

  it("errors on malformed or zero-length time windows", () => {
    expect(parseScheduleText("mon nine-to-five").ok).toBe(false);
    expect(parseScheduleText("mon 09:00").ok).toBe(false);
    expect(parseScheduleText("mon 09:00-25:00").ok).toBe(false);
    expect(parseScheduleText("mon 09:00-17:00,").ok).toBe(false);
    const zeroLength = parseScheduleText("mon 09:00-09:00");
    expect(zeroLength.ok).toBe(false);
    if (!zeroLength.ok) expect(zeroLength.error).toContain("starts and ends at the same time");
  });

  it("accepts an overnight window (the engine splits it across midnight)", () => {
    expect(parseScheduleText("tue 18:00-02:00")).toEqual({
      ok: true,
      value: { tue: [["18:00", "02:00"]] }
    });
  });
});

describe("normalizeWeeklyWindowsJson", () => {
  it("passes a valid stored value through, zero-padding times", () => {
    expect(
      normalizeWeeklyWindowsJson({ mon: [["9:00", "17:00"]], sun: [["10:00", "11:00"]] })
    ).toEqual({ mon: [["09:00", "17:00"]], sun: [["10:00", "11:00"]] });
  });

  it("returns null for non-objects, arrays, and empty values", () => {
    expect(normalizeWeeklyWindowsJson(null)).toBeNull();
    expect(normalizeWeeklyWindowsJson("mon")).toBeNull();
    expect(normalizeWeeklyWindowsJson([])).toBeNull();
    expect(normalizeWeeklyWindowsJson({})).toBeNull();
  });

  it("drops malformed entries and returns null when nothing valid remains", () => {
    expect(
      normalizeWeeklyWindowsJson({
        mon: [["bad", "17:00"], ["09:00", 5], ["09:00"], "x", ["09:00", "09:00"]],
        tue: "closed",
        funday: [["09:00", "17:00"]]
      })
    ).toBeNull();
    expect(
      normalizeWeeklyWindowsJson({
        mon: [["bad", "17:00"], ["09:00", "17:00"]]
      })
    ).toEqual({ mon: [["09:00", "17:00"]] });
  });

  it("keeps a stored overnight window (round-trips back to the form)", () => {
    expect(normalizeWeeklyWindowsJson({ tue: [["18:00", "02:00"]] })).toEqual({
      tue: [["18:00", "02:00"]]
    });
  });
});

describe("formatScheduleText", () => {
  it("renders empty string for unset/invalid values", () => {
    expect(formatScheduleText(null)).toBe("");
    expect(formatScheduleText({})).toBe("");
    expect(formatScheduleText("garbage")).toBe("");
  });

  it("groups consecutive days with identical windows into ranges", () => {
    expect(
      formatScheduleText({
        mon: [["09:00", "17:00"]],
        tue: [["09:00", "17:00"]],
        wed: [["09:00", "17:00"]],
        thu: [["09:00", "17:00"]],
        fri: [["09:00", "17:00"]],
        sat: [["10:00", "14:00"]]
      })
    ).toBe("mon-fri 09:00-17:00; sat 10:00-14:00");
  });

  it("does NOT group non-consecutive days even when windows match", () => {
    expect(
      formatScheduleText({ mon: [["09:00", "17:00"]], wed: [["09:00", "17:00"]] })
    ).toBe("mon 09:00-17:00; wed 09:00-17:00");
  });

  it("renders multiple windows per day comma-separated", () => {
    expect(
      formatScheduleText({ mon: [["09:00", "12:00"], ["13:00", "17:00"]] })
    ).toBe("mon 09:00-12:00, 13:00-17:00");
  });

  it("splits groups where windows differ between adjacent days", () => {
    expect(
      formatScheduleText({
        mon: [["09:00", "17:00"]],
        tue: [["10:00", "16:00"]]
      })
    ).toBe("mon 09:00-17:00; tue 10:00-16:00");
  });

  it("round-trips with parseScheduleText", () => {
    const text = "mon-fri 09:00-17:00; sat 10:00-14:00";
    const parsed = parseScheduleText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(formatScheduleText(parsed.value)).toBe(text);
  });
});
