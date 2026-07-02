import { describe, expect, it } from "vitest";

import {
  addUtcMonthsClamped,
  deriveMonthlyQuotaWindow
} from "../supabase/functions/_shared/billing_period_window";

describe("addUtcMonthsClamped", () => {
  it("adds whole months preserving day and time-of-day", () => {
    expect(addUtcMonthsClamped(new Date("2026-03-15T08:30:00.000Z"), 2).toISOString()).toBe(
      "2026-05-15T08:30:00.000Z"
    );
  });

  it("clamps the day-of-month to the target month's length", () => {
    expect(addUtcMonthsClamped(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z"
    );
    // Leap year February.
    expect(addUtcMonthsClamped(new Date("2028-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
  });

  it("crosses year boundaries", () => {
    expect(addUtcMonthsClamped(new Date("2026-11-05T12:00:00.000Z"), 3).toISOString()).toBe(
      "2027-02-05T12:00:00.000Z"
    );
  });
});

describe("deriveMonthlyQuotaWindow", () => {
  const periodStart = "2026-05-29T21:33:49+00:00";

  it("window 0 echoes the input string verbatim (monthly-sub key compatibility)", () => {
    const w = deriveMonthlyQuotaWindow(periodStart, new Date("2026-06-10T00:00:00.000Z").getTime());
    expect(w.startIso).toBe(periodStart);
    expect(w.endIso).toBe("2026-06-29T21:33:49.000Z");
  });

  it("now before the period start still resolves to window 0", () => {
    const w = deriveMonthlyQuotaWindow(periodStart, new Date("2026-05-01T00:00:00.000Z").getTime());
    expect(w.startIso).toBe(periodStart);
  });

  it("later month-windows anchor to the period start's day and time", () => {
    const w = deriveMonthlyQuotaWindow(periodStart, new Date("2026-10-10T00:00:00.000Z").getTime());
    expect(w.startIso).toBe("2026-09-29T21:33:49.000Z");
    expect(w.endIso).toBe("2026-10-29T21:33:49.000Z");
  });

  it("boundary instants belong to the window they open", () => {
    const boundary = new Date("2026-06-29T21:33:49.000Z").getTime();
    expect(deriveMonthlyQuotaWindow(periodStart, boundary).startIso).toBe(
      "2026-06-29T21:33:49.000Z"
    );
    expect(deriveMonthlyQuotaWindow(periodStart, boundary - 1).startIso).toBe(periodStart);
  });

  it("clamped month ends stay consistent across the whole term (Jan 31 anchor)", () => {
    const start = "2026-01-31T00:00:00.000Z";
    expect(
      deriveMonthlyQuotaWindow(start, new Date("2026-02-28T00:00:00.000Z").getTime()).startIso
    ).toBe("2026-02-28T00:00:00.000Z");
    expect(
      deriveMonthlyQuotaWindow(start, new Date("2026-03-30T23:59:59.999Z").getTime()).startIso
    ).toBe("2026-02-28T00:00:00.000Z");
    expect(
      deriveMonthlyQuotaWindow(start, new Date("2026-03-31T00:00:00.000Z").getTime()).startIso
    ).toBe("2026-03-31T00:00:00.000Z");
  });

  it("covers a full 24-month prepaid term without gaps or overlaps", () => {
    const start = "2026-07-01T00:00:00.000Z";
    let cursor = new Date(start).getTime();
    for (let i = 0; i < 24; i++) {
      const w = deriveMonthlyQuotaWindow(start, cursor);
      expect(new Date(w.startIso).getTime()).toBe(cursor);
      const end = new Date(w.endIso).getTime();
      expect(end).toBeGreaterThan(cursor);
      // The instant before the boundary still belongs to this window.
      expect(deriveMonthlyQuotaWindow(start, end - 1).endIso).toBe(w.endIso);
      cursor = end;
    }
    expect(new Date(cursor).toISOString()).toBe("2028-07-01T00:00:00.000Z");
  });

  it("unparseable input degrades to a degenerate echo window", () => {
    const w = deriveMonthlyQuotaWindow("not-a-date", Date.now());
    expect(w).toEqual({ startIso: "not-a-date", endIso: "not-a-date" });
  });
});
