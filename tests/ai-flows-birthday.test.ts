import { describe, expect, it } from "vitest";
import {
  BIRTHDAY_DEFAULT_TIME,
  birthdayDedupeKey,
  birthdayDue,
  contactAge,
  localYearIn,
  parseBirthday
} from "../supabase/functions/_shared/ai_flows/birthday";

/**
 * Birthday trigger due-checks: local-date matching in the trigger timezone,
 * the send-time gate, the Feb 29 → Mar 1 fallback, and the once-per-year
 * dedupe key.
 */

// 2026-07-10 17:30 UTC = 10:30 in Phoenix (UTC-7, no DST).
const NOW = Date.parse("2026-07-10T17:30:00Z");
const PHX = "America/Phoenix";

describe("parseBirthday", () => {
  it("parses DATE column values (with or without a time suffix)", () => {
    expect(parseBirthday("1990-07-10")).toEqual({ year: 1990, month: 7, day: 10 });
    expect(parseBirthday("1990-07-10T00:00:00")).toEqual({ year: 1990, month: 7, day: 10 });
  });
  it("rejects junk and out-of-range parts", () => {
    expect(parseBirthday(null)).toBeNull();
    expect(parseBirthday("")).toBeNull();
    expect(parseBirthday("July 10")).toBeNull();
    expect(parseBirthday("1990-13-01")).toBeNull();
    expect(parseBirthday("1990-00-10")).toBeNull();
    expect(parseBirthday("1990-01-32")).toBeNull();
  });
});

describe("birthdayDue", () => {
  it("fires when the local month/day matches and the send time has passed", () => {
    expect(birthdayDue("1990-07-10", NOW, PHX, "09:00")).toBe(true);
    // 10:30 local < 11:00 send time → not yet.
    expect(birthdayDue("1990-07-10", NOW, PHX, "11:00")).toBe(false);
    // Wrong day.
    expect(birthdayDue("1990-07-11", NOW, PHX, "09:00")).toBe(false);
    // No birthday → never.
    expect(birthdayDue(null, NOW, PHX)).toBe(false);
  });

  it("uses the default 09:00 send time (and falls back to it on a junk time)", () => {
    expect(BIRTHDAY_DEFAULT_TIME).toBe("09:00");
    expect(birthdayDue("1990-07-10", NOW, PHX)).toBe(true);
    expect(birthdayDue("1990-07-10", NOW, PHX, "not-a-time")).toBe(true);
  });

  it("respects the timezone: the same instant is a different date elsewhere", () => {
    // 2026-07-10 17:30 UTC is already July 11, 02:30 in Tokyo.
    expect(birthdayDue("1990-07-11", NOW, "Asia/Tokyo", "01:00")).toBe(true);
    expect(birthdayDue("1990-07-10", NOW, "Asia/Tokyo", "01:00")).toBe(false);
  });

  it("fails open to UTC on a junk timezone", () => {
    expect(birthdayDue("1990-07-10", NOW, "Not/AZone", "09:00")).toBe(true);
  });

  it("Feb 29 birthdays fire on Mar 1 in non-leap years only", () => {
    // 2026 is not a leap year: Mar 1 2026, noon UTC.
    const mar1 = Date.parse("2026-03-01T19:00:00Z");
    expect(birthdayDue("1996-02-29", mar1, PHX, "09:00")).toBe(true);
    // 2028 IS a leap year: Feb 29 exists, so Mar 1 must NOT fire...
    const mar1Leap = Date.parse("2028-03-01T19:00:00Z");
    expect(birthdayDue("1996-02-29", mar1Leap, PHX, "09:00")).toBe(false);
    // ...and Feb 29 itself does.
    const feb29 = Date.parse("2028-02-29T19:00:00Z");
    expect(birthdayDue("1996-02-29", feb29, PHX, "09:00")).toBe(true);
  });
});

describe("birthdayDedupeKey / contactAge / localYearIn", () => {
  it("keys one firing per contact per year", () => {
    expect(birthdayDedupeKey("c1", 2026)).toBe("bday:c1:2026");
  });
  it("age from the stored year, guarding placeholder years", () => {
    expect(contactAge("1990-07-10", 2026)).toBe(36);
    expect(contactAge("0004-07-10", 2026)).toBeNull(); // implausible
    expect(contactAge("2026-07-10", 2026)).toBeNull(); // zero
    expect(contactAge("junk", 2026)).toBeNull();
  });
  it("localYearIn resolves the year in the zone", () => {
    // Dec 31 2026, 23:30 in Phoenix = Jan 1 2027, 06:30 UTC.
    const nye = Date.parse("2027-01-01T06:30:00Z");
    expect(localYearIn(nye, PHX)).toBe(2026);
    expect(localYearIn(nye, "UTC")).toBe(2027);
  });
});
