import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_GROWTH_MONTHS,
  MIN_MONTHS_FOR_TREND,
  completeMonths,
  composeGrowthReport,
  daysInMonth,
  hasReportableActivity,
  linearFit,
  loadGrowthReport,
  projectNextMonth,
  type SnapshotRow
} from "@/lib/analytics/growth-report";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/residency/read", () => ({
  isVpsReadMode: vi.fn(async () => false),
  countMovedRows: vi.fn(async () => 0)
}));

import { isVpsReadMode, countMovedRows } from "@/lib/residency/read";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/** Sep 4 2026: past the send day, so August is the newest complete month. */
const NOW = new Date("2026-09-04T16:20:00.000Z");

const snapshot = (date: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  snapshot_date: date,
  calls: 1,
  sms_sent: 10,
  voice_minutes: 5,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVpsReadMode).mockResolvedValue(false);
});

describe("month helpers", () => {
  it("lists only months that have ended, oldest first", () => {
    expect(completeMonths(NOW, 3)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("never includes the month in progress, even on its last day", () => {
    expect(completeMonths(new Date("2026-09-30T23:59:00Z"), 1)).toEqual(["2026-08"]);
  });

  it("crosses a year boundary", () => {
    expect(completeMonths(new Date("2026-01-04T00:00:00Z"), 2)).toEqual(["2025-11", "2025-12"]);
  });

  it("returns nothing for a nonsensical count", () => {
    expect(completeMonths(NOW, 0)).toEqual([]);
    expect(completeMonths(NOW, -3)).toEqual([]);
  });

  it("knows how long each month is, leap year included", () => {
    expect(daysInMonth("2026-08")).toBe(31);
    expect(daysInMonth("2026-09")).toBe(30);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
  });

  it("looks back six months by default and needs three to draw a line", () => {
    expect(DEFAULT_GROWTH_MONTHS).toBe(6);
    expect(MIN_MONTHS_FOR_TREND).toBe(3);
  });
});

describe("projection", () => {
  it("fits a straight line through a rising series", () => {
    expect(linearFit([10, 20, 30])).toEqual({ slope: 10, intercept: 10 });
  });

  it("fits a flat line through a flat series", () => {
    expect(linearFit([7, 7, 7])).toEqual({ slope: 0, intercept: 7 });
  });

  it("projects the next point of the trend", () => {
    expect(projectNextMonth([10, 20, 30])).toBe(40);
  });

  it("floors a falling trend at zero rather than predicting negative work", () => {
    expect(projectNextMonth([30, 15, 2])).toBe(0);
  });

  it("refuses to forecast from fewer than three months", () => {
    expect(projectNextMonth([10, 40])).toBeNull();
    expect(projectNextMonth([])).toBeNull();
  });

  it("rounds to a whole count", () => {
    expect(projectNextMonth([10, 11, 13])).toBe(14);
  });
});

describe("composeGrowthReport", () => {
  it("sums snapshot days into their month and counts coverage", () => {
    const report = composeGrowthReport({
      months: ["2026-07", "2026-08"],
      snapshots: [
        snapshot("2026-07-01"),
        snapshot("2026-08-01"),
        snapshot("2026-08-02", { calls: 3, sms_sent: 20, voice_minutes: 11 })
      ],
      leadsByMonth: new Map([
        ["2026-07", 108],
        ["2026-08", 127]
      ])
    });
    expect(report.months[1]).toEqual({
      month: "2026-08",
      leads: 127,
      texts: 30,
      calls: 4,
      voiceMinutes: 16,
      coveredDays: 2,
      daysInMonth: 31
    });
    expect(report.latest!.month).toBe("2026-08");
    expect(report.previous!.month).toBe("2026-07");
  });

  it("treats null snapshot columns as zero", () => {
    const report = composeGrowthReport({
      months: ["2026-08"],
      snapshots: [{ snapshot_date: "2026-08-01", calls: null, sms_sent: null, voice_minutes: null }],
      leadsByMonth: new Map()
    });
    expect(report.latest).toMatchObject({ calls: 0, texts: 0, voiceMinutes: 0, coveredDays: 1 });
  });

  it("ignores a snapshot day outside the window, which leaves nothing measured", () => {
    const report = composeGrowthReport({
      months: ["2026-08"],
      snapshots: [snapshot("2026-05-01")],
      leadsByMonth: new Map()
    });
    expect(report.months).toEqual([]);
    expect(report.latest).toBeNull();
  });

  it("drops a month nobody was measuring instead of reporting it as zero", () => {
    // Amy's real shape before the snapshot sweep shipped: June had 38 leads
    // from `contacts` but no snapshot rows at all, so reporting it would have
    // put a real lead count beside a fabricated zero for texts and calls.
    const report = composeGrowthReport({
      months: ["2026-06", "2026-07"],
      snapshots: [snapshot("2026-07-15", { sms_sent: 390, calls: 20 })],
      leadsByMonth: new Map([
        ["2026-06", 38],
        ["2026-07", 108]
      ])
    });
    expect(report.months.map((m) => m.month)).toEqual(["2026-07"]);
    expect(report.previous).toBeNull();
    expect(report.changes).toBeNull();
  });

  it("keeps a measured month that happened to be quiet", () => {
    const report = composeGrowthReport({
      months: ["2026-07", "2026-08"],
      snapshots: [
        snapshot("2026-07-15", { calls: 0, sms_sent: 0, voice_minutes: 0 }),
        snapshot("2026-08-15")
      ],
      leadsByMonth: new Map()
    });
    expect(report.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
  });

  it("computes the change against the previous month", () => {
    const report = composeGrowthReport({
      months: ["2026-07", "2026-08"],
      snapshots: [snapshot("2026-07-01"), snapshot("2026-08-01")],
      leadsByMonth: new Map([
        ["2026-07", 100],
        ["2026-08", 150]
      ])
    });
    expect(report.changes!.leads).toMatchObject({ current: 150, previous: 100, percent: 50, direction: "up" });
  });

  it("has no changes and no previous month on a first full month", () => {
    const report = composeGrowthReport({
      months: ["2026-08"],
      snapshots: [snapshot("2026-08-01")],
      leadsByMonth: new Map([["2026-08", 4]])
    });
    expect(report.previous).toBeNull();
    expect(report.changes).toBeNull();
    expect(report.projection).toBeNull();
  });

  it("has no latest month at all when the window is empty", () => {
    const report = composeGrowthReport({ months: [], snapshots: [], leadsByMonth: new Map() });
    expect(report.latest).toBeNull();
    expect(report.latestMonthIncomplete).toBe(false);
  });

  it("projects every metric once there is enough history", () => {
    const report = composeGrowthReport({
      months: ["2026-06", "2026-07", "2026-08"],
      snapshots: [
        snapshot("2026-06-01", { calls: 1, sms_sent: 10, voice_minutes: 2 }),
        snapshot("2026-07-01", { calls: 2, sms_sent: 20, voice_minutes: 4 }),
        snapshot("2026-08-01", { calls: 3, sms_sent: 30, voice_minutes: 6 })
      ],
      leadsByMonth: new Map([
        ["2026-06", 51],
        ["2026-07", 108],
        ["2026-08", 127]
      ])
    });
    expect(report.projection).toEqual({ leads: 171, texts: 40, calls: 4, voiceMinutes: 8 });
  });

  it("flags a month that is missing snapshot days", () => {
    const full = Array.from({ length: 31 }, (_, i) =>
      snapshot(`2026-08-${String(i + 1).padStart(2, "0")}`)
    );
    expect(
      composeGrowthReport({ months: ["2026-08"], snapshots: full, leadsByMonth: new Map() })
        .latestMonthIncomplete
    ).toBe(false);
    expect(
      composeGrowthReport({
        months: ["2026-08"],
        snapshots: full.slice(0, 10),
        leadsByMonth: new Map()
      }).latestMonthIncomplete
    ).toBe(true);
  });
});

describe("hasReportableActivity", () => {
  const withLatest = (over: Partial<{ leads: number; texts: number; calls: number }>) =>
    composeGrowthReport({
      months: ["2026-08"],
      snapshots: [
        snapshot("2026-08-01", { calls: over.calls ?? 0, sms_sent: over.texts ?? 0, voice_minutes: 0 })
      ],
      leadsByMonth: new Map([["2026-08", over.leads ?? 0]])
    });

  it("is false for a silent month", () => {
    expect(hasReportableActivity(withLatest({}))).toBe(false);
  });

  it("is true when any of the three headline metrics moved", () => {
    expect(hasReportableActivity(withLatest({ leads: 1 }))).toBe(true);
    expect(hasReportableActivity(withLatest({ texts: 1 }))).toBe(true);
    expect(hasReportableActivity(withLatest({ calls: 1 }))).toBe(true);
  });

  it("is false when there is no complete month", () => {
    expect(
      hasReportableActivity(composeGrowthReport({ months: [], snapshots: [], leadsByMonth: new Map() }))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/** Client mock: one snapshot read, then one head-count per month. */
function mockClient(opts: {
  snapshots?: SnapshotRow[];
  /** PostgREST can answer with a null body and no error; that is not a failure. */
  nullSnapshots?: boolean;
  snapshotError?: string;
  counts?: number[];
  countError?: string;
}) {
  let countIndex = 0;
  const snapshotBuilder = {
    select: () => snapshotBuilder,
    eq: () => snapshotBuilder,
    gte: () => snapshotBuilder,
    lt: () =>
      Promise.resolve(
        opts.snapshotError
          ? { data: null, error: { message: opts.snapshotError } }
          : { data: opts.nullSnapshots ? null : (opts.snapshots ?? []), error: null }
      )
  };
  const countBuilder = {
    select: () => countBuilder,
    eq: () => countBuilder,
    gte: () => countBuilder,
    lt: () => {
      const value = opts.counts?.[countIndex] ?? 0;
      countIndex += 1;
      return Promise.resolve(
        opts.countError
          ? { count: null, error: { message: opts.countError } }
          : { count: value, error: null }
      );
    }
  };
  return {
    from(table: string) {
      return table === "analytics_daily_snapshots" ? snapshotBuilder : countBuilder;
    }
  } as never;
}

describe("loadGrowthReport", () => {
  it("reads the window's snapshots once and counts leads per month", async () => {
    const client = mockClient({
      snapshots: [snapshot("2026-08-01"), snapshot("2026-07-01")],
      counts: [108, 127]
    });
    const report = await loadGrowthReport("biz-1", { client, now: NOW, months: 2 });
    expect(report.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
    expect(report.months.map((m) => m.leads)).toEqual([108, 127]);
    expect(report.latest!.texts).toBe(10);
  });

  it("routes the lead count to the tenant's own box in residency mode", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(countMovedRows).mockResolvedValue(42);
    const client = mockClient({ snapshots: [snapshot("2026-08-01")] });
    const report = await loadGrowthReport("biz-1", { client, now: NOW, months: 1 });
    expect(report.latest!.leads).toBe(42);
    expect(countMovedRows).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ table: "contacts" })
    );
  });

  it("returns an empty report rather than querying when no month is complete", async () => {
    const client = mockClient({ snapshots: [] });
    const report = await loadGrowthReport("biz-1", { client, now: NOW, months: 0 });
    expect(report.months).toEqual([]);
    expect(isVpsReadMode).not.toHaveBeenCalled();
  });

  it("treats a null-but-not-an-error snapshot page as nothing measured", async () => {
    const client = mockClient({ nullSnapshots: true });
    const report = await loadGrowthReport("biz-1", { client, now: NOW, months: 1 });
    expect(report.latest).toBeNull();
  });

  it("throws with the source name on a snapshot read error", async () => {
    const client = mockClient({ snapshotError: "snapshots down" });
    await expect(loadGrowthReport("biz-1", { client, now: NOW, months: 1 })).rejects.toThrow(
      /growth report snapshots: snapshots down/
    );
  });

  it("throws with the source name on a contact count error", async () => {
    const client = mockClient({ snapshots: [], countError: "contacts down" });
    await expect(loadGrowthReport("biz-1", { client, now: NOW, months: 1 })).rejects.toThrow(
      /growth report contacts: contacts down/
    );
  });

  it("treats a null count as zero leads for a month that WAS measured", async () => {
    const client = {
      from: (table: string) =>
        table === "analytics_daily_snapshots"
          ? {
              select: () => ({
                eq: () => ({
                  gte: () => ({
                    lt: () =>
                      Promise.resolve({ data: [snapshot("2026-08-01")], error: null })
                  })
                })
              })
            }
          : {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    gte: () => ({ lt: () => Promise.resolve({ count: null, error: null }) })
                  })
                })
              })
            }
    } as never;
    const report = await loadGrowthReport("biz-1", { client, now: NOW, months: 1 });
    expect(report.latest!.leads).toBe(0);
    expect(report.latest!.coveredDays).toBe(1);
  });

  it("falls back to the service client when none is injected", async () => {
    const client = mockClient({ snapshots: [snapshot("2026-08-01")], counts: [7] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const report = await loadGrowthReport("biz-1", { now: NOW, months: 1 });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(report.latest!.leads).toBe(7);
  });

  it("uses the wall clock when no now is injected", async () => {
    // Anchored to the real clock rather than a fixed date: a hardcoded month
    // here is a time bomb that goes off the month it stops being "last month".
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    const client = mockClient({ snapshots: [snapshot(`${expected}-01`)], counts: [3] });
    const report = await loadGrowthReport("biz-1", { client, months: 1 });
    expect(report.latest!.month).toBe(expected);
    expect(report.latest!.leads).toBe(3);
  });

  it("looks back the default number of months when none is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const client = mockClient({
        snapshots: Array.from({ length: DEFAULT_GROWTH_MONTHS }, (_, i) =>
          snapshot(`2026-0${i + 3}-01`)
        )
      });
      const report = await loadGrowthReport("biz-1", { client });
      expect(report.months).toHaveLength(DEFAULT_GROWTH_MONTHS);
      expect(report.latest!.month).toBe("2026-08");
    } finally {
      vi.useRealTimers();
    }
  });
});
