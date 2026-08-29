/**
 * The month window, the fold and the projection are module-private: an export
 * whose only caller is a test is dead code wearing coverage (see
 * scripts/knip-exports-ratchet.mjs). Everything here therefore drives
 * `loadGrowthReport`, which is what the sweep calls, with a mock client
 * serving the one snapshot read and the per-month contact counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyRecap, loadGrowthReport } from "@/lib/analytics/growth-report";

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

type SnapshotRow = {
  snapshot_date: string;
  calls: number | null;
  sms_sent: number | null;
  voice_minutes: number | null;
};

const snapshot = (date: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  snapshot_date: date,
  calls: 1,
  sms_sent: 10,
  voice_minutes: 5,
  ...over
});

/** Every day of `month`, so the month reads as fully covered. */
function fullMonth(month: string, over: Partial<SnapshotRow> = {}): SnapshotRow[] {
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
  ).getUTCDate();
  return Array.from({ length: days }, (_, i) =>
    snapshot(`${month}-${String(i + 1).padStart(2, "0")}`, over)
  );
}

/**
 * The snapshot read and the per-month head counts, as thenable builders.
 *
 * Thenable rather than resolving on a specific terminal method: the snapshot
 * query deliberately has no upper bound any more (the days AFTER the reported
 * month are what answer "are they still using this?"), and a mock that only
 * resolved on `.lt()` would silently hand back the builder instead of a row
 * set the moment that changed.
 */
function mockClient(opts: {
  snapshots?: SnapshotRow[];
  /** PostgREST can answer with a null body and no error; that is not a failure. */
  nullSnapshots?: boolean;
  snapshotError?: string;
  /** Lead counts, consumed oldest month first. */
  counts?: number[];
  nullCount?: boolean;
  countError?: string;
}) {
  let countIndex = 0;

  const snapshotResult = () =>
    opts.snapshotError
      ? { data: null, error: { message: opts.snapshotError } }
      : { data: opts.nullSnapshots ? null : (opts.snapshots ?? []), error: null };

  const countResult = () => {
    if (opts.countError) return { count: null, error: { message: opts.countError } };
    const value = opts.counts?.[countIndex] ?? 0;
    countIndex += 1;
    return { count: opts.nullCount ? null : value, error: null };
  };

  const builder = (result: () => unknown): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled, onRejected)
    };
    for (const method of ["select", "eq", "gte", "lt", "order"]) b[method] = () => b;
    return b;
  };

  const snapshotBuilder = builder(snapshotResult);
  return {
    from: (table: string) =>
      table === "analytics_daily_snapshots" ? snapshotBuilder : builder(countResult)
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVpsReadMode).mockResolvedValue(false);
});

describe("the window", () => {
  it("covers only months that have ended, oldest first", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [...fullMonth("2026-06"), ...fullMonth("2026-07"), ...fullMonth("2026-08")]
      }),
      now: NOW,
      months: 3
    });
    expect(report.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("never includes the month in progress, even on its last day", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: fullMonth("2026-08") }),
      now: new Date("2026-09-30T23:59:00Z"),
      months: 1
    });
    expect(report.latest!.month).toBe("2026-08");
  });

  it("crosses a year boundary", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: [...fullMonth("2025-11"), ...fullMonth("2025-12")] }),
      now: new Date("2026-01-04T00:00:00Z"),
      months: 2
    });
    expect(report.months.map((m) => m.month)).toEqual(["2025-11", "2025-12"]);
  });

  it("returns an empty report, without querying, for a nonsensical count", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({}),
      now: NOW,
      months: 0
    });
    expect(report.months).toEqual([]);
    expect(report.latest).toBeNull();
    expect(isVpsReadMode).not.toHaveBeenCalled();
  });

  it("looks back six months by default", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: ["03", "04", "05", "06", "07", "08"].flatMap((m) => fullMonth(`2026-${m}`))
      }),
      now: NOW
    });
    expect(report.months).toHaveLength(6);
    expect(report.latest!.month).toBe("2026-08");
  });

  it("uses the wall clock when no now is injected", async () => {
    // Anchored to the real clock: a hardcoded month here is a time bomb that
    // goes off the month it stops being "last month".
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: fullMonth(expected), counts: [3] }),
      months: 1
    });
    expect(report.latest!.month).toBe(expected);
    expect(report.latest!.leads).toBe(3);
  });

  it("knows how long each month is, leap year included", async () => {
    for (const [month, days] of [
      ["2026-08", 31],
      ["2026-09", 30],
      ["2026-02", 28],
      ["2028-02", 29]
    ] as const) {
      const report = await loadGrowthReport("biz-1", {
        client: mockClient({ snapshots: [snapshot(`${month}-01`)] }),
        now: new Date(`${month}-15T00:00:00Z`),
        months: 2
      });
      const hit = report.months.find((m) => m.month === month);
      expect(hit?.daysInMonth ?? days).toBe(days);
    }
  });
});

describe("the fold", () => {
  it("sums snapshot days into their month and counts coverage", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [
          ...fullMonth("2026-07"),
          snapshot("2026-08-01"),
          snapshot("2026-08-02", { calls: 3, sms_sent: 20, voice_minutes: 11 })
        ],
        counts: [108, 127]
      }),
      now: NOW,
      months: 2
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
    expect(report.previous!.month).toBe("2026-07");
  });

  it("treats null snapshot columns as zero", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [{ snapshot_date: "2026-08-01", calls: null, sms_sent: null, voice_minutes: null }]
      }),
      now: NOW,
      months: 1
    });
    expect(report.latest).toMatchObject({ calls: 0, texts: 0, voiceMinutes: 0, coveredDays: 1 });
  });

  it("ignores a snapshot day outside the window, which leaves nothing measured", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: [snapshot("2026-05-01")] }),
      now: NOW,
      months: 1
    });
    expect(report.months).toEqual([]);
    expect(report.latest).toBeNull();
  });

  it("drops a month nobody was measuring instead of reporting it as zero", async () => {
    // Amy's real shape before the snapshot sweep shipped: June had 38 leads
    // from `contacts` but no snapshot rows at all, so reporting it would have
    // put a real lead count beside a fabricated zero for texts and calls.
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [snapshot("2026-07-15", { sms_sent: 390, calls: 20 })],
        counts: [38, 108]
      }),
      now: new Date("2026-08-04T00:00:00Z"),
      months: 2
    });
    expect(report.months.map((m) => m.month)).toEqual(["2026-07"]);
    expect(report.previous).toBeNull();
    expect(report.changes).toBeNull();
  });

  it("keeps a measured month that happened to be quiet", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [
          snapshot("2026-07-15", { calls: 0, sms_sent: 0, voice_minutes: 0 }),
          snapshot("2026-08-15")
        ]
      }),
      now: NOW,
      months: 2
    });
    expect(report.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
  });

  it("computes the change against the previous month", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [snapshot("2026-07-01"), snapshot("2026-08-01")],
        counts: [100, 150]
      }),
      now: NOW,
      months: 2
    });
    expect(report.changes!.leads).toMatchObject({
      current: 150,
      previous: 100,
      percent: 50,
      direction: "up"
    });
  });

  it("flags a month that is missing snapshot days", async () => {
    const complete = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: fullMonth("2026-08") }),
      now: NOW,
      months: 1
    });
    expect(complete.latestMonthIncomplete).toBe(false);

    const partial = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: fullMonth("2026-08").slice(0, 10) }),
      now: NOW,
      months: 1
    });
    expect(partial.latestMonthIncomplete).toBe(true);
  });
});

describe("the projection", () => {
  const rising = async (leads: number[], per: Partial<SnapshotRow>[]) =>
    await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [
          ...fullMonth("2026-06", per[0]),
          ...fullMonth("2026-07", per[1]),
          ...fullMonth("2026-08", per[2])
        ],
        counts: leads
      }),
      now: NOW,
      months: 3
    });

  it("extends a straight line through every metric", async () => {
    const report = await rising(
      [51, 108, 127],
      [
        { calls: 1, sms_sent: 10, voice_minutes: 2 },
        { calls: 2, sms_sent: 20, voice_minutes: 4 },
        { calls: 3, sms_sent: 30, voice_minutes: 6 }
      ]
    );
    // Least squares over [51, 108, 127] puts the next point at 171.
    expect(report.projection!.leads).toBe(171);
    expect(report.projection!.calls).toBeGreaterThan(report.latest!.calls);
  });

  it("floors a falling trend at zero rather than predicting negative work", async () => {
    const report = await rising(
      [30, 15, 2],
      [{ calls: 1 }, { calls: 1 }, { calls: 1 }]
    );
    expect(report.projection!.leads).toBe(0);
  });

  it("refuses to forecast from fewer than three months", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [...fullMonth("2026-07"), ...fullMonth("2026-08")],
        counts: [10, 40]
      }),
      now: NOW,
      months: 2
    });
    expect(report.projection).toBeNull();
  });

  it("stays flat on a flat series", async () => {
    const report = await rising([7, 7, 7], [{ calls: 1 }, { calls: 1 }, { calls: 1 }]);
    expect(report.projection!.leads).toBe(7);
  });
});

describe("classifyRecap", () => {
  /** A busy, fully-covered August, plus days in September so they read active. */
  const busy = () => [
    ...fullMonth("2026-08", { calls: 2, sms_sent: 20, voice_minutes: 5 }),
    snapshot("2026-09-02", { calls: 1, sms_sent: 5 })
  ];

  it("sends for a covered, busy, still-active month", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: busy(), counts: [40] }),
      now: NOW,
      months: 1
    });
    expect(classifyRecap(report)).toBe("send");
  });

  it("says no_month when nothing measured has finished", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({}),
      now: NOW,
      months: 0
    });
    expect(classifyRecap(report)).toBe("no_month");
  });

  it("says dormant when the tenant stopped after a busy start", async () => {
    // Real shape: they worked leads Aug 1-4, then nothing. `now` is Sep 4, so
    // the trailing 30 days start Aug 5 and are empty. A cheerful August recap
    // would land on someone who has already left.
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: Array.from({ length: 4 }, (_, i) =>
          snapshot(`2026-08-0${i + 1}`, { calls: 4, sms_sent: 40 })
        ),
        counts: [30]
      }),
      now: NOW,
      months: 1
    });
    expect(report.recentlyActive).toBe(false);
    expect(classifyRecap(report)).toBe("dormant");
  });

  it("counts a day exactly on the window edge as inside it", async () => {
    // Sep 4 minus 30 days is Aug 5, and the comparison is inclusive, so a
    // tenant whose last activity was that day is active, not dormant.
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [snapshot("2026-08-05", { calls: 4, sms_sent: 40 })],
        counts: [30]
      }),
      now: NOW,
      months: 1
    });
    expect(report.recentlyActive).toBe(true);
  });

  it("counts a call or a text in the trailing window as still active", async () => {
    for (const recent of [{ calls: 1, sms_sent: 0 }, { calls: 0, sms_sent: 1 }]) {
      const report = await loadGrowthReport("biz-1", {
        client: mockClient({
          snapshots: [...fullMonth("2026-08", { calls: 1, sms_sent: 10 }), snapshot("2026-09-02", recent)],
          counts: [20]
        }),
        now: NOW,
        months: 1
      });
      expect(report.recentlyActive).toBe(true);
    }
  });

  it("does not count a silent day in the trailing window as activity", async () => {
    // Everything real is before the Aug 5 cutoff; the only day inside the
    // window is a snapshot row with nothing on it, which the sweep writes for
    // every business every day whether or not anything happened.
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [
          ...Array.from({ length: 4 }, (_, i) =>
            snapshot(`2026-08-0${i + 1}`, { calls: 1, sms_sent: 10 })
          ),
          snapshot("2026-09-02", { calls: 0, sms_sent: 0 })
        ],
        counts: [20]
      }),
      now: NOW,
      months: 1
    });
    expect(report.recentlyActive).toBe(false);
  });

  it("says thin when the month is barely covered", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [
          ...Array.from({ length: 6 }, (_, i) =>
            snapshot(`2026-08-0${i + 1}`, { calls: 5, sms_sent: 50 })
          ),
          snapshot("2026-09-02", { calls: 1, sms_sent: 5 })
        ],
        counts: [40]
      }),
      now: NOW,
      months: 1
    });
    // Active and busy, but six days is a sample, not a month.
    expect(report.recentlyActive).toBe(true);
    expect(classifyRecap(report)).toBe("thin");
  });

  it("says thin when almost nothing happened in a fully covered month", async () => {
    const days = fullMonth("2026-08", { calls: 0, sms_sent: 0, voice_minutes: 0 });
    days[0] = snapshot("2026-08-01", { calls: 1, sms_sent: 1, voice_minutes: 0 });
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [...days, snapshot("2026-09-02", { calls: 1, sms_sent: 0 })],
        counts: [1]
      }),
      now: NOW,
      months: 1
    });
    // 1 lead + 1 text + 1 call = 3 events, under the bar.
    expect(classifyRecap(report)).toBe("thin");
  });

  it("sends at exactly the event bar", async () => {
    const days = fullMonth("2026-08", { calls: 0, sms_sent: 0, voice_minutes: 0 });
    days[0] = snapshot("2026-08-01", { calls: 2, sms_sent: 2, voice_minutes: 0 });
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({
        snapshots: [...days, snapshot("2026-09-02", { calls: 1, sms_sent: 0 })],
        counts: [1]
      }),
      now: NOW,
      months: 1
    });
    // 1 lead + 2 texts + 2 calls = 5.
    expect(classifyRecap(report)).toBe("send");
  });
});

describe("reads", () => {
  it("routes the lead count to the tenant's own box in residency mode", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(countMovedRows).mockResolvedValue(42);
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: [snapshot("2026-08-01")] }),
      now: NOW,
      months: 1
    });
    expect(report.latest!.leads).toBe(42);
    expect(countMovedRows).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ table: "contacts" })
    );
  });

  it("treats a null-but-not-an-error snapshot page as nothing measured", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ nullSnapshots: true }),
      now: NOW,
      months: 1
    });
    expect(report.latest).toBeNull();
  });

  it("treats a null count as zero leads for a month that WAS measured", async () => {
    const report = await loadGrowthReport("biz-1", {
      client: mockClient({ snapshots: [snapshot("2026-08-01")], nullCount: true }),
      now: NOW,
      months: 1
    });
    expect(report.latest!.leads).toBe(0);
    expect(report.latest!.coveredDays).toBe(1);
  });

  it("throws with the source name on a snapshot read error", async () => {
    await expect(
      loadGrowthReport("biz-1", {
        client: mockClient({ snapshotError: "snapshots down" }),
        now: NOW,
        months: 1
      })
    ).rejects.toThrow(/growth report snapshots: snapshots down/);
  });

  it("throws with the source name on a contact count error", async () => {
    await expect(
      loadGrowthReport("biz-1", {
        client: mockClient({ snapshots: [], countError: "contacts down" }),
        now: NOW,
        months: 1
      })
    ).rejects.toThrow(/growth report contacts: contacts down/);
  });

  it("falls back to the service client when none is injected", async () => {
    const client = mockClient({ snapshots: [snapshot("2026-08-01")], counts: [7] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const report = await loadGrowthReport("biz-1", { now: NOW, months: 1 });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(report.latest!.leads).toBe(7);
  });
});
