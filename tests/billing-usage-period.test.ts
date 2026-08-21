import { describe, expect, it } from "vitest";

import {
  calendarMonthResetAt,
  formatUsagePeriodDate,
  monthlyUsageResetAt,
  soonestExpiryAt
} from "@/lib/billing/usage-period";

describe("monthlyUsageResetAt", () => {
  it("returns the end of the current month-window for a monthly plan", () => {
    // Window 0: the tenant is inside the first month after the period start.
    const at = monthlyUsageResetAt(
      "2026-08-01T00:00:00.000Z",
      Date.parse("2026-08-21T12:00:00.000Z")
    );
    expect(at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("follows the monthly window inside a multi-month prepaid term", () => {
    // The point of the change: a 24-month term starting Jul 28 2026 bills
    // once and renews in 2028, but included usage still refills every month,
    // so on Aug 21 the date to show is Aug 28 and not the 2028 renewal.
    const at = monthlyUsageResetAt(
      "2026-07-28T17:30:00.000Z",
      Date.parse("2026-08-21T00:00:00.000Z")
    );
    expect(at).toBe("2026-08-28T17:30:00.000Z");

    // A month later the window has advanced with it.
    expect(
      monthlyUsageResetAt("2026-07-28T17:30:00.000Z", Date.parse("2026-09-02T00:00:00.000Z"))
    ).toBe("2026-09-28T17:30:00.000Z");
  });

  it("clamps the day of month the same way the quota key does", () => {
    // A Jan 31 anchor lands on Feb 28 in a non-leap year.
    const at = monthlyUsageResetAt(
      "2027-01-31T00:00:00.000Z",
      Date.parse("2027-01-31T06:00:00.000Z")
    );
    expect(at).toBe("2027-02-28T00:00:00.000Z");
  });

  it("returns null without a usable period anchor", () => {
    expect(monthlyUsageResetAt(null, Date.now())).toBeNull();
    expect(monthlyUsageResetAt(undefined, Date.now())).toBeNull();
    expect(monthlyUsageResetAt("", Date.now())).toBeNull();
    // Unparseable: deriveMonthlyQuotaWindow would echo the input back, and
    // showing a window START as a reset date would be wrong.
    expect(monthlyUsageResetAt("not-a-date", Date.now())).toBeNull();
  });
});

describe("calendarMonthResetAt", () => {
  it("returns the start of the next UTC calendar month", () => {
    expect(calendarMonthResetAt(Date.parse("2026-08-21T18:00:00.000Z"))).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });

  it("rolls December over into the next year", () => {
    expect(calendarMonthResetAt(Date.parse("2026-12-31T23:59:59.000Z"))).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("is unaffected by the local zone of the instant passed in", () => {
    // 2026-09-01T01:00+02:00 is still Aug 31 in UTC, so the reset is Sep 1.
    expect(calendarMonthResetAt(Date.parse("2026-09-01T01:00:00.000+02:00"))).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });
});

describe("soonestExpiryAt", () => {
  it("picks the earliest expiry", () => {
    expect(
      soonestExpiryAt([
        "2026-11-01T00:00:00.000Z",
        "2026-09-15T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z"
      ])
    ).toBe("2026-09-15T00:00:00.000Z");
  });

  it("keeps the first of two identical expiries", () => {
    expect(
      soonestExpiryAt(["2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z"])
    ).toBe("2026-09-15T00:00:00.000Z");
  });

  it("skips blank and unparseable entries", () => {
    expect(soonestExpiryAt([null, undefined, "", "nope", "2026-10-02T00:00:00.000Z"])).toBe(
      "2026-10-02T00:00:00.000Z"
    );
  });

  it("returns null when nothing usable is left", () => {
    expect(soonestExpiryAt([])).toBeNull();
    expect(soonestExpiryAt([null, "garbage"])).toBeNull();
  });
});

describe("formatUsagePeriodDate", () => {
  it("formats in UTC, not the runner's zone", () => {
    // The boundary instant is midnight UTC on Sep 1. Formatting in a
    // behind-UTC zone would read "Aug 31", which is the wrong day to tell a
    // tenant their texts reset.
    expect(formatUsagePeriodDate("2026-09-01T00:00:00.000Z", "en")).toBe("Sep 1, 2026");
  });

  it("honours the requested locale", () => {
    expect(formatUsagePeriodDate("2028-07-28T17:30:00.000Z", "es")).toContain("2028");
  });

  it("echoes an unparseable value instead of rendering Invalid Date", () => {
    expect(formatUsagePeriodDate("not-a-date", "en")).toBe("not-a-date");
  });
});
