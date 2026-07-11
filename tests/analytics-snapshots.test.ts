import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin CENTRAL residency mode: the transcript scan's VPS branch is covered by
// tests/residency-read-flip.test.ts.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  listBusinesses: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  FORECAST_MIN_DAYS,
  SNAPSHOT_BACKFILL_DAYS,
  computeDailySnapshot,
  forecastActivity,
  getSnapshotSeries,
  runSnapshotSweep,
  upsertDailySnapshot,
  type DailySnapshot
} from "@/lib/analytics/snapshots";
import { listBusinesses } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type QueryResult = { data?: unknown; count?: number | null; error: { message: string } | null };

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "upsert", "eq", "neq", "gte", "lt", "lte", "order", "limit", "maybeSingle"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    onF: (v: QueryResult) => unknown,
    onR: (e: unknown) => unknown
  ) => Promise.resolve(result).then(onF, onR);
  return chain;
}

function makeClient(resultsByTable: Record<string, QueryResult>) {
  const chains: Record<string, ReturnType<typeof makeChain>> = {};
  const from = vi.fn((table: string) => {
    chains[table] = makeChain(resultsByTable[table] ?? { data: [], count: 0, error: null });
    return chains[table];
  });
  return { client: { from } as never, from, chains };
}

const NOW = new Date("2026-07-04T12:00:00Z");
const BIZ = "biz-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeDailySnapshot", () => {
  it("aggregates one UTC day: calls, minutes, inbound sentiment, texts, refusals", async () => {
    const { client, chains } = makeClient({
      voice_call_transcripts: {
        data: [
          // 120s inbound positive + 60s outbound (sentiment ignored on
          // outbound) + in-progress inbound with an unknown sentiment label.
          {
            started_at: "2026-07-03T10:00:00Z",
            ended_at: "2026-07-03T10:02:00Z",
            direction: "inbound",
            sentiment: "positive"
          },
          {
            started_at: "2026-07-03T11:00:00Z",
            ended_at: "2026-07-03T11:01:00Z",
            direction: "outbound",
            sentiment: "negative"
          },
          {
            started_at: "2026-07-03T12:00:00Z",
            ended_at: null,
            direction: "inbound",
            sentiment: "weird"
          },
          // Clock-skewed end contributes the call but zero minutes.
          {
            started_at: "2026-07-03T13:00:00Z",
            ended_at: "2026-07-03T12:00:00Z",
            direction: "inbound",
            sentiment: null
          },
          {
            started_at: "2026-07-03T14:00:00Z",
            ended_at: "garbage",
            direction: "inbound",
            sentiment: "neutral"
          }
        ],
        error: null
      },
      daily_usage: { data: { sms_sent: 12 }, error: null },
      system_logs: { data: null, count: 2, error: null }
    });

    const snapshot = await computeDailySnapshot(BIZ, "2026-07-03", { client });
    expect(snapshot).toEqual({
      businessId: BIZ,
      snapshotDate: "2026-07-03",
      calls: 5,
      inboundCalls: 4,
      voiceMinutes: 3,
      smsSent: 12,
      missedCalls: 2,
      sentiment: { positive: 1, neutral: 1, negative: 0, mixed: 0 }
    });
    const transcripts = chains.voice_call_transcripts as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", "2026-07-03T00:00:00.000Z");
    expect(transcripts.lt).toHaveBeenCalledWith("started_at", "2026-07-04T00:00:00.000Z");
  });

  it("handles a missing usage row, null sms, and null blocked count", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      daily_usage: { data: null, error: null },
      system_logs: { data: null, count: null, error: null }
    });
    const snapshot = await computeDailySnapshot(BIZ, "2026-07-03", { client });
    expect(snapshot).toMatchObject({ calls: 0, smsSent: 0, missedCalls: 0 });

    const { client: nullSms } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      daily_usage: { data: { sms_sent: null }, error: null },
      system_logs: { data: null, count: 0, error: null }
    });
    expect((await computeDailySnapshot(BIZ, "2026-07-03", { client: nullSms })).smsSent).toBe(0);
  });

  it("throws on usage / blocked query errors and defaults the client", async () => {
    const usageErr = makeClient({
      voice_call_transcripts: { data: [], error: null },
      daily_usage: { data: null, error: { message: "usage down" } },
      system_logs: { data: null, count: 0, error: null }
    });
    await expect(
      computeDailySnapshot(BIZ, "2026-07-03", { client: usageErr.client })
    ).rejects.toThrow("computeDailySnapshot sms: usage down");

    const blockedErr = makeClient({
      voice_call_transcripts: { data: [], error: null },
      daily_usage: { data: null, error: null },
      system_logs: { data: null, count: null, error: { message: "logs down" } }
    });
    await expect(
      computeDailySnapshot(BIZ, "2026-07-03", { client: blockedErr.client })
    ).rejects.toThrow("computeDailySnapshot blocked: logs down");

    const ok = makeClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.client as never);
    expect((await computeDailySnapshot(BIZ, "2026-07-03")).calls).toBe(0);
  });
});

function snapshotFixture(overrides: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    businessId: BIZ,
    snapshotDate: "2026-07-03",
    calls: 5,
    inboundCalls: 4,
    voiceMinutes: 3,
    smsSent: 12,
    missedCalls: 2,
    sentiment: { positive: 1, neutral: 1, negative: 0, mixed: 0 },
    ...overrides
  };
}

describe("upsertDailySnapshot", () => {
  it("upserts on the (business, day) key and maps the column names", async () => {
    const { client, chains } = makeClient({
      analytics_daily_snapshots: { data: null, error: null }
    });
    await upsertDailySnapshot(snapshotFixture(), { client });
    const chain = chains.analytics_daily_snapshots as { upsert: ReturnType<typeof vi.fn> };
    const [row, opts] = chain.upsert.mock.calls[0];
    expect(row).toMatchObject({
      business_id: BIZ,
      snapshot_date: "2026-07-03",
      calls: 5,
      inbound_calls: 4,
      voice_minutes: 3,
      sms_sent: 12,
      missed_calls: 2,
      sentiment_positive: 1,
      sentiment_neutral: 1,
      sentiment_negative: 0,
      sentiment_mixed: 0
    });
    expect(opts).toEqual({ onConflict: "business_id,snapshot_date" });
  });

  it("throws on a write error and defaults the client", async () => {
    const { client } = makeClient({
      analytics_daily_snapshots: { data: null, error: { message: "write down" } }
    });
    await expect(upsertDailySnapshot(snapshotFixture(), { client })).rejects.toThrow(
      "upsertDailySnapshot: write down"
    );

    const ok = makeClient({ analytics_daily_snapshots: { data: null, error: null } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.client as never);
    await upsertDailySnapshot(snapshotFixture());
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("runSnapshotSweep", () => {
  it("recomputes the backfill window for every business", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([{ id: "b1" }, { id: "b2" }] as never);
    const { client, from } = makeClient({});
    const result = await runSnapshotSweep({ client, now: NOW });
    expect(result).toEqual({
      businesses: 2,
      snapshots: 2 * SNAPSHOT_BACKFILL_DAYS,
      errors: []
    });
    // Each snapshot = 3 reads + 1 upsert.
    expect(from).toHaveBeenCalledTimes(2 * SNAPSHOT_BACKFILL_DAYS * 4);
  });

  it("records per-tenant failures (Error and non-Error) and keeps sweeping", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([{ id: "b1" }, { id: "b2" }] as never);
    let calls = 0;
    const failingClient = {
      from: vi.fn((table: string) => {
        calls += 1;
        // First business's first read fails with an Error; second business's
        // first read rejects with a non-Error.
        const shouldFail = table === "daily_usage";
        return makeChain(
          shouldFail
            ? { data: null, error: { message: calls < 10 ? "b1 down" : "b2 down" } }
            : { data: [], count: 0, error: null }
        );
      })
    } as never;
    const result = await runSnapshotSweep({ client: failingClient, now: NOW });
    expect(result.businesses).toBe(2);
    expect(result.snapshots).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].businessId).toBe("b1");
    expect(result.errors[1].businessId).toBe("b2");
  });

  it("defaults the client and now", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([] as never);
    const { client } = makeClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const result = await runSnapshotSweep();
    expect(result).toEqual({ businesses: 0, snapshots: 0, errors: [] });
  });

  it("stringifies non-Error tenant failures", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([{ id: "b1" }] as never);
    // Reject through the AWAITED chain (never throw synchronously from
    // `from()`): a sync throw during Promise.all argument construction would
    // strand the already-started sibling reads as unhandled rejections.
    const rejectingChain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lt", "order", "limit", "maybeSingle"]) {
      rejectingChain[m] = vi.fn(() => rejectingChain);
    }
    (rejectingChain as { then: unknown }).then = (
      _onF: unknown,
      onR: (e: unknown) => unknown
    ) => Promise.reject("string failure").then(undefined, onR);
    const throwing = { from: vi.fn(() => rejectingChain) } as never;
    const result = await runSnapshotSweep({ client: throwing, now: NOW });
    expect(result.errors).toEqual([{ businessId: "b1", message: "string failure" }]);
  });
});

describe("getSnapshotSeries", () => {
  it("zero-fills the window ending yesterday and reports covered days", async () => {
    const { client, chains } = makeClient({
      analytics_daily_snapshots: {
        data: [
          {
            snapshot_date: "2026-07-02",
            calls: 3,
            sms_sent: 8,
            voice_minutes: 5,
            inbound_calls: 2,
            missed_calls: 1
          }
        ],
        error: null
      }
    });
    const series = await getSnapshotSeries(BIZ, 3, { client, now: NOW });
    expect(series.coveredDays).toBe(1);
    expect(series.points).toEqual([
      { date: "2026-07-01", calls: 0, smsSent: 0, voiceMinutes: 0, inboundCalls: 0, missedCalls: 0 },
      { date: "2026-07-02", calls: 3, smsSent: 8, voiceMinutes: 5, inboundCalls: 2, missedCalls: 1 },
      { date: "2026-07-03", calls: 0, smsSent: 0, voiceMinutes: 0, inboundCalls: 0, missedCalls: 0 }
    ]);
    const chain = chains.analytics_daily_snapshots as {
      gte: ReturnType<typeof vi.fn>;
      lte: ReturnType<typeof vi.fn>;
    };
    expect(chain.gte).toHaveBeenCalledWith("snapshot_date", "2026-07-01");
    expect(chain.lte).toHaveBeenCalledWith("snapshot_date", "2026-07-03");
  });

  it("handles a null page, throws on errors, and defaults client/now", async () => {
    const { client } = makeClient({
      analytics_daily_snapshots: { data: null, error: null }
    });
    const series = await getSnapshotSeries(BIZ, 2, { client, now: NOW });
    expect(series.coveredDays).toBe(0);
    expect(series.points).toHaveLength(2);

    const errClient = makeClient({
      analytics_daily_snapshots: { data: null, error: { message: "read down" } }
    });
    await expect(getSnapshotSeries(BIZ, 2, { client: errClient.client, now: NOW })).rejects.toThrow(
      "getSnapshotSeries: read down"
    );

    const ok = makeClient({ analytics_daily_snapshots: { data: [], error: null } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.client as never);
    expect((await getSnapshotSeries(BIZ, 1)).points).toHaveLength(1);
  });
});

describe("forecastActivity", () => {
  it("returns null below the minimum history", () => {
    expect(forecastActivity(Array(FORECAST_MIN_DAYS - 1).fill(5))).toBeNull();
  });

  it("a flat series forecasts steady at the mean", () => {
    const forecast = forecastActivity(Array(28).fill(4));
    expect(forecast).toEqual({
      dailyAverage: 4,
      trendPerDay: 0,
      projected30d: 120,
      direction: "stable",
      anomaly: null
    });
  });

  it("a rising series trends up; a falling one trends down with a zero clamp", () => {
    const rising = forecastActivity(Array.from({ length: 28 }, (_, i) => i));
    expect(rising?.direction).toBe("up");
    expect(rising?.trendPerDay).toBe(1);
    // fitted end = 27; next 30 days sum = Σ (27 + i) for i=1..30
    expect(rising?.projected30d).toBe(27 * 30 + (30 * 31) / 2);

    const falling = forecastActivity(Array.from({ length: 28 }, (_, i) => 27 - i));
    expect(falling?.direction).toBe("down");
    // fitted end = 0; every projected day clamps at zero.
    expect(falling?.projected30d).toBe(0);
  });

  it("flags a quiet or busy final week only over a loud-enough baseline", () => {
    // Baseline 10/day for 21 days, then a near-silent week.
    const quiet = forecastActivity([...Array(21).fill(10), ...Array(7).fill(1)]);
    expect(quiet?.anomaly).toBe("quiet");

    const busy = forecastActivity([...Array(21).fill(10), ...Array(7).fill(20)]);
    expect(busy?.anomaly).toBe("busy");

    // Prior baseline under 5/week → ratio is noise, no flag.
    const faint = forecastActivity([...Array(21).fill(0.5), ...Array(7).fill(2)]);
    expect(faint?.anomaly).toBeNull();
  });
});
