/**
 * Prospecting compliance gates (src/lib/outreach/compliance.ts): the
 * prospect-scoped unsubscribe token, the weekday send window, the daily-cap
 * window, the once-a-day discovery gate, and opt-out detection.
 */
import { describe, expect, it } from "vitest";

import {
  buildOutreachUnsubscribeUrl,
  discoveryDueToday,
  isWithinSendWindow,
  localWeekdayAndHour,
  looksLikeOptOut,
  outreachUnsubscribeToken,
  utcDayStartIso,
  verifyOutreachUnsubscribeToken,
  weekdayIndex
} from "@/lib/outreach/compliance";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

describe("unsubscribe token", () => {
  it("round-trips, and only for the row it was minted for", () => {
    const token = outreachUnsubscribeToken(BIZ, PROSPECT);
    expect(token).toHaveLength(32);
    expect(verifyOutreachUnsubscribeToken(BIZ, PROSPECT, token)).toBe(true);
    expect(verifyOutreachUnsubscribeToken(BIZ, "33333333-3333-4333-8333-333333333333", token)).toBe(
      false
    );
    expect(verifyOutreachUnsubscribeToken("other-biz", PROSPECT, token)).toBe(false);
  });

  it("rejects a token of the wrong length without a timing-unsafe compare", () => {
    expect(verifyOutreachUnsubscribeToken(BIZ, PROSPECT, "short")).toBe(false);
    expect(verifyOutreachUnsubscribeToken(BIZ, PROSPECT, "")).toBe(false);
  });

  it("builds a link the route can verify, with the base URL normalized", () => {
    const url = buildOutreachUnsubscribeUrl("https://app.example.com///", BIZ, PROSPECT);
    expect(url).toContain("https://app.example.com/api/outreach/unsubscribe?");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("bid")).toBe(BIZ);
    expect(parsed.searchParams.get("p")).toBe(PROSPECT);
    expect(
      verifyOutreachUnsubscribeToken(BIZ, PROSPECT, parsed.searchParams.get("t") as string)
    ).toBe(true);
  });
});

describe("localWeekdayAndHour", () => {
  it("reads the weekday and hour in the named zone", () => {
    // 2026-07-27 is a Monday. 09:00 UTC is 02:00 in Phoenix.
    expect(localWeekdayAndHour(new Date("2026-07-27T09:00:00Z"), "America/Phoenix")).toEqual({
      weekday: 1,
      hour: 2
    });
    // A blank or missing zone means UTC rather than the server's locale.
    expect(localWeekdayAndHour(new Date("2026-07-27T09:00:00Z"), "  ")).toEqual({
      weekday: 1,
      hour: 9
    });
    expect(localWeekdayAndHour(new Date("2026-07-27T09:00:00Z"), null)).toEqual({
      weekday: 1,
      hour: 9
    });
  });

  it("falls back to UTC on an unknown zone instead of failing the pass", () => {
    expect(localWeekdayAndHour(new Date("2026-07-26T15:00:00Z"), "Mars/Olympus")).toEqual({
      weekday: 0,
      hour: 15
    });
  });

  it("resolves an unrecognized weekday name to a real day, never to -1", () => {
    expect(weekdayIndex("Sun")).toBe(0);
    expect(weekdayIndex("Fri")).toBe(5);
    // -1 would read as neither weekend nor weekday and send outside the window.
    expect(weekdayIndex("Freitag")).toBe(0);
  });
});

describe("isWithinSendWindow", () => {
  const zone = "America/Phoenix";

  it("sends inside a weekday morning window only", () => {
    // Monday 16:00 UTC = 09:00 Phoenix.
    expect(isWithinSendWindow(new Date("2026-07-27T16:00:00Z"), zone, 8, 11)).toBe(true);
    // Monday 19:00 UTC = 12:00 Phoenix, past the window.
    expect(isWithinSendWindow(new Date("2026-07-27T19:00:00Z"), zone, 8, 11)).toBe(false);
    // Monday 13:00 UTC = 06:00 Phoenix, before it.
    expect(isWithinSendWindow(new Date("2026-07-27T13:00:00Z"), zone, 8, 11)).toBe(false);
    // The end hour is exclusive: 11:00 local is already out.
    expect(isWithinSendWindow(new Date("2026-07-27T18:00:00Z"), zone, 8, 11)).toBe(false);
  });

  it("never sends at the weekend", () => {
    // Friday 09:00 Phoenix sends, and the same hour on Saturday and Sunday
    // does not: a cold email that lands on Saturday is read on Monday
    // alongside the weekend's spam, if at all.
    expect(isWithinSendWindow(new Date("2026-07-24T16:00:00Z"), zone, 8, 11)).toBe(true);
    expect(isWithinSendWindow(new Date("2026-07-25T16:00:00Z"), zone, 8, 11)).toBe(false);
    expect(isWithinSendWindow(new Date("2026-07-26T16:00:00Z"), zone, 8, 11)).toBe(false);
  });
});

describe("utcDayStartIso / discoveryDueToday", () => {
  it("anchors the daily cap to the start of the UTC day", () => {
    expect(utcDayStartIso(new Date("2026-07-27T23:59:59Z"))).toBe("2026-07-27T00:00:00.000Z");
  });

  it("allows one discovery pass per UTC day", () => {
    const now = new Date("2026-07-27T16:00:00Z");
    expect(discoveryDueToday(null, now)).toBe(true);
    expect(discoveryDueToday("2026-07-26T23:00:00Z", now)).toBe(true);
    expect(discoveryDueToday("2026-07-27T01:00:00Z", now)).toBe(false);
    // An unparseable stamp must not wedge discovery off forever.
    expect(discoveryDueToday("not a date", now)).toBe(true);
  });
});

describe("looksLikeOptOut", () => {
  it("recognizes the ways people ask to be left alone", () => {
    for (const reply of [
      "Please unsubscribe me",
      "REMOVE ME from your list",
      "take me off this list",
      "not interested, thanks",
      "opt-out"
    ]) {
      expect(looksLikeOptOut(reply)).toBe(true);
    }
  });

  it("leaves a real reply for the coworker to answer", () => {
    expect(looksLikeOptOut("Sure, how much does it cost?")).toBe(false);
    expect(looksLikeOptOut("")).toBe(false);
  });
});
