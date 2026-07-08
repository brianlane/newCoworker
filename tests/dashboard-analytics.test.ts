import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ANALYTICS_CALL_SCAN_LIMIT,
  ANALYTICS_DAY_CALL_LIMIT,
  ANALYTICS_WINDOW_DAYS,
  analyticsWindowStart,
  getAnalyticsDayDetail,
  getAnswerRateStats,
  getDailyUsageSeries,
  getInboundCallStats,
  hourInTimeZone,
  isValidAnalyticsDay
} from "@/lib/analytics/dashboard-analytics";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type QueryResult = { data?: unknown; count?: number | null; error: { message: string } | null };

/**
 * Builder-style chain: every method returns the chain, and awaiting the chain
 * resolves the injected result — matches how supabase-js PostgrestFilterBuilder
 * is consumed by the lib (thenable at any chain depth).
 */
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "gte", "lt", "order", "limit", "maybeSingle"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    onF: (v: QueryResult) => unknown,
    onR: (e: unknown) => unknown
  ) => Promise.resolve(result).then(onF, onR);
  return chain;
}

/** Client whose from() dispatches a fresh chain per table name. */
function makeClient(resultsByTable: Record<string, QueryResult>) {
  const chains: Record<string, ReturnType<typeof makeChain>> = {};
  const from = vi.fn((table: string) => {
    chains[table] = makeChain(resultsByTable[table] ?? { data: [], count: 0, error: null });
    return chains[table];
  });
  return { client: { from } as never, from, chains };
}

const NOW = new Date("2026-07-04T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analyticsWindowStart", () => {
  it("returns midnight UTC of the day (days - 1) ago so every card shares one boundary", () => {
    expect(analyticsWindowStart(NOW, 3).toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(analyticsWindowStart(NOW, 1).toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });
});

describe("getDailyUsageSeries", () => {
  it("zero-fills the window and totals the rows", async () => {
    const { client, chains } = makeClient({
      daily_usage: {
        data: [
          { usage_date: "2026-07-03", calls_made: 4, sms_sent: 10, voice_minutes_used: 12 },
          { usage_date: "2026-07-04", calls_made: 1, sms_sent: null, voice_minutes_used: 3 }
        ],
        error: null
      }
    });

    const series = await getDailyUsageSeries("biz-1", { client, days: 3, now: NOW });

    expect(series.days).toEqual([
      { date: "2026-07-02", calls: 0, sms: 0, voiceMinutes: 0 },
      { date: "2026-07-03", calls: 4, sms: 10, voiceMinutes: 12 },
      { date: "2026-07-04", calls: 1, sms: 0, voiceMinutes: 3 }
    ]);
    expect(series.totals).toEqual({ calls: 5, sms: 10, voiceMinutes: 15 });
    const chain = chains.daily_usage as { gte: ReturnType<typeof vi.fn> };
    expect(chain.gte).toHaveBeenCalledWith("usage_date", "2026-07-02");
  });

  it("handles a null data payload", async () => {
    const { client } = makeClient({ daily_usage: { data: null, error: null } });
    const series = await getDailyUsageSeries("biz-1", { client, days: 2, now: NOW });
    expect(series.days).toHaveLength(2);
    expect(series.totals).toEqual({ calls: 0, sms: 0, voiceMinutes: 0 });
  });

  it("throws on query error", async () => {
    const { client } = makeClient({ daily_usage: { data: null, error: { message: "boom" } } });
    await expect(getDailyUsageSeries("biz-1", { client, now: NOW })).rejects.toThrow(
      "getDailyUsageSeries: boom"
    );
  });

  it("defaults to the shared client, window, and now", async () => {
    const { client } = makeClient({ daily_usage: { data: [], error: null } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const series = await getDailyUsageSeries("biz-1");
    expect(series.days).toHaveLength(ANALYTICS_WINDOW_DAYS);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("isValidAnalyticsDay", () => {
  it("accepts a real YYYY-MM-DD date", () => {
    expect(isValidAnalyticsDay("2026-07-04")).toBe(true);
    expect(isValidAnalyticsDay("2024-02-29")).toBe(true); // leap day
  });

  it("rejects malformed strings", () => {
    expect(isValidAnalyticsDay("2026-7-4")).toBe(false);
    expect(isValidAnalyticsDay("20260704")).toBe(false);
    expect(isValidAnalyticsDay("garbage")).toBe(false);
    expect(isValidAnalyticsDay("2026-07-04T00:00:00Z")).toBe(false);
  });

  it("rejects unparseable and rolled-over calendar dates", () => {
    // Regex-shaped but unparseable → Invalid Date.
    expect(isValidAnalyticsDay("2026-99-99")).toBe(false);
    // V8 parses 2026-02-31 by rolling into March; the round-trip check catches it.
    expect(isValidAnalyticsDay("2026-02-31")).toBe(false);
  });
});

describe("getAnalyticsDayDetail", () => {
  const DAY = "2026-07-03";
  const CALL = {
    id: "t-1",
    caller_e164: "+15550001111",
    started_at: "2026-07-03T09:15:00Z",
    ended_at: "2026-07-03T09:20:00Z",
    status: "completed",
    direction: "inbound",
    call_kind: "ai",
    forwarded_to_e164: null,
    summary: "Booked a repair.",
    sentiment: "positive"
  };

  it("returns the day's usage, calls, and turned-away count", async () => {
    const { client, chains } = makeClient({
      daily_usage: {
        data: { calls_made: 4, sms_sent: 10, voice_minutes_used: 12 },
        error: null
      },
      voice_call_transcripts: {
        data: [
          CALL,
          {
            ...CALL,
            id: "t-2",
            call_kind: "forwarded",
            forwarded_to_e164: "+15559998888",
            summary: null,
            // Unknown sentiment strings are dropped rather than rendered.
            sentiment: "confused"
          },
          { ...CALL, id: "t-3", sentiment: null }
        ],
        error: null
      },
      system_logs: { count: 2, error: null }
    });

    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });

    expect(detail.date).toBe(DAY);
    expect(detail.usage).toEqual({ calls: 4, sms: 10, voiceMinutes: 12 });
    expect(detail.turnedAway).toBe(2);
    expect(detail.clipped).toBe(false);
    expect(detail.calls).toHaveLength(3);
    expect(detail.calls[0]).toEqual({
      id: "t-1",
      callerE164: "+15550001111",
      startedAt: "2026-07-03T09:15:00Z",
      endedAt: "2026-07-03T09:20:00Z",
      status: "completed",
      direction: "inbound",
      callKind: "ai",
      forwardedTo: null,
      summary: "Booked a repair.",
      sentiment: "positive"
    });
    expect(detail.calls[1].forwardedTo).toBe("+15559998888");
    expect(detail.calls[1].sentiment).toBeNull();
    expect(detail.calls[2].sentiment).toBeNull();

    // The day is sliced [00:00 UTC, next 00:00 UTC) — same bucketing as daily_usage.
    const transcripts = chains.voice_call_transcripts as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
      neq: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", "2026-07-03T00:00:00.000Z");
    expect(transcripts.lt).toHaveBeenCalledWith("started_at", "2026-07-04T00:00:00.000Z");
    // Missed forwarded calls live in the turned-away count, not the call list.
    expect(transcripts.neq).toHaveBeenCalledWith("status", "missed");
    expect(transcripts.limit).toHaveBeenCalledWith(ANALYTICS_DAY_CALL_LIMIT);
    const logs = chains.system_logs as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(logs.gte).toHaveBeenCalledWith("created_at", "2026-07-03T00:00:00.000Z");
    expect(logs.lt).toHaveBeenCalledWith("created_at", "2026-07-04T00:00:00.000Z");
  });

  it("zero-fills when the day has no usage row, calls, or blocked count", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: null, error: null },
      system_logs: { count: null, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.usage).toEqual({ calls: 0, sms: 0, voiceMinutes: 0 });
    expect(detail.calls).toEqual([]);
    expect(detail.turnedAway).toBe(0);
    expect(detail.clipped).toBe(false);
  });

  it("treats null usage columns as zero", async () => {
    const { client } = makeClient({
      daily_usage: {
        data: { calls_made: null, sms_sent: null, voice_minutes_used: null },
        error: null
      },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { count: 0, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.usage).toEqual({ calls: 0, sms: 0, voiceMinutes: 0 });
  });

  it("flags the call list as clipped at the row cap", async () => {
    const full = Array.from({ length: ANALYTICS_DAY_CALL_LIMIT }, (_, i) => ({
      ...CALL,
      id: `t-${i}`
    }));
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: full, error: null },
      system_logs: { count: 0, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.clipped).toBe(true);
    expect(detail.calls).toHaveLength(ANALYTICS_DAY_CALL_LIMIT);
  });

  it("throws when the usage lookup errors", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: { message: "u down" } },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { count: 0, error: null }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail usage: u down"
    );
  });

  it("throws when the call scan errors", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: null, error: { message: "c down" } },
      system_logs: { count: 0, error: null }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail calls: c down"
    );
  });

  it("throws when the blocked count errors", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { count: null, error: { message: "b down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail blocked: b down"
    );
  });

  it("defaults to the shared client", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { count: 0, error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const detail = await getAnalyticsDayDetail("biz-1", DAY);
    expect(detail.calls).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("hourInTimeZone", () => {
  it("returns the hour in the given IANA timezone", () => {
    // 19:30 UTC = 12:30 in Phoenix (UTC-7, no DST).
    expect(hourInTimeZone("2026-07-04T19:30:00Z", "America/Phoenix")).toBe(12);
  });

  it("falls back to UTC for null and invalid timezones", () => {
    expect(hourInTimeZone("2026-07-04T19:30:00Z", null)).toBe(19);
    expect(hourInTimeZone("2026-07-04T19:30:00Z", undefined)).toBe(19);
    expect(hourInTimeZone("2026-07-04T19:30:00Z", "Not/AZone")).toBe(19);
  });
});

describe("getInboundCallStats", () => {
  it("builds the hour histogram (answered + turned away) and sentiment mix", async () => {
    const { client, chains } = makeClient({
      voice_call_transcripts: {
        data: [
          { started_at: "2026-07-04T09:15:00Z", sentiment: "positive" },
          { started_at: "2026-07-04T09:45:00Z", sentiment: null },
          { started_at: "2026-07-03T17:00:00Z", sentiment: "negative" },
          // Unknown sentiment string is counted in the histogram but not the mix.
          { started_at: "2026-07-03T17:30:00Z", sentiment: "confused" }
        ],
        error: null
      },
      // Turned-away attempts land in the histogram too — a rush of refusals
      // is the peak-hours signal that matters most.
      system_logs: {
        data: [{ created_at: "2026-07-04T09:50:00Z" }, { created_at: "2026-07-02T08:00:00Z" }],
        error: null
      }
    });

    const stats = await getInboundCallStats("biz-1", { client, now: NOW });

    expect(stats.callCount).toBe(6);
    expect(stats.hourBuckets[9]).toBe(3);
    expect(stats.hourBuckets[17]).toBe(2);
    expect(stats.hourBuckets[8]).toBe(1);
    expect(stats.hourBuckets.reduce((a, b) => a + b, 0)).toBe(6);
    expect(stats.sentiment).toEqual({ positive: 1, neutral: 0, negative: 1, mixed: 0 });
    expect(stats.sentimentTotal).toBe(2);
    expect(stats.clipped).toBe(false);
    const expectedCutoff = analyticsWindowStart(NOW, ANALYTICS_WINDOW_DAYS).toISOString();
    const transcripts = chains.voice_call_transcripts as {
      limit: ReturnType<typeof vi.fn>;
      gte: ReturnType<typeof vi.fn>;
      neq: ReturnType<typeof vi.fn>;
    };
    const logs = chains.system_logs as {
      limit: ReturnType<typeof vi.fn>;
      gte: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.limit).toHaveBeenCalledWith(ANALYTICS_CALL_SCAN_LIMIT);
    // Missed forwarded calls live on the voice_call_blocked side of the
    // histogram — the transcript scan must exclude them or they'd count twice.
    expect(transcripts.neq).toHaveBeenCalledWith("status", "missed");
    expect(logs.limit).toHaveBeenCalledWith(ANALYTICS_CALL_SCAN_LIMIT);
    // Same day-aligned boundary as the volume series (30 inclusive UTC days).
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", expectedCutoff);
    expect(logs.gte).toHaveBeenCalledWith("created_at", expectedCutoff);
  });

  it("applies the business timezone to the histogram", async () => {
    const { client } = makeClient({
      voice_call_transcripts: {
        data: [{ started_at: "2026-07-04T19:30:00Z", sentiment: null }],
        error: null
      }
    });
    const stats = await getInboundCallStats("biz-1", {
      client,
      now: NOW,
      timeZone: "America/Phoenix"
    });
    expect(stats.hourBuckets[12]).toBe(1);
  });

  it("flags the result as clipped when a scan hits the row cap", async () => {
    const full = Array.from({ length: ANALYTICS_CALL_SCAN_LIMIT }, (_, i) => ({
      created_at: new Date(NOW.getTime() - i * 60_000).toISOString()
    }));
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: full, error: null }
    });
    const stats = await getInboundCallStats("biz-1", { client, now: NOW });
    expect(stats.clipped).toBe(true);
    expect(stats.callCount).toBe(ANALYTICS_CALL_SCAN_LIMIT);
  });

  it("handles null data payloads from both scans", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: null, error: null },
      system_logs: { data: null, error: null }
    });
    const stats = await getInboundCallStats("biz-1", { client, now: NOW });
    expect(stats.callCount).toBe(0);
    expect(stats.sentimentTotal).toBe(0);
  });

  it("throws on transcript scan error", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: null, error: { message: "scan down" } }
    });
    await expect(getInboundCallStats("biz-1", { client, now: NOW })).rejects.toThrow(
      "getInboundCallStats: scan down"
    );
  });

  it("throws on blocked-call scan error", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, error: { message: "logs down" } }
    });
    await expect(getInboundCallStats("biz-1", { client, now: NOW })).rejects.toThrow(
      "getInboundCallStats blocked: logs down"
    );
  });

  it("defaults to the shared client and window", async () => {
    const { client } = makeClient({ voice_call_transcripts: { data: [], error: null } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const stats = await getInboundCallStats("biz-1");
    expect(stats.callCount).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("getAnswerRateStats", () => {
  it("computes answered vs missed and the rate", async () => {
    const { client, chains } = makeClient({
      voice_call_transcripts: { count: 9, error: null },
      system_logs: { count: 1, error: null }
    });
    const stats = await getAnswerRateStats("biz-1", { client, now: NOW });
    expect(stats).toEqual({ answered: 9, missed: 1, rate: 0.9 });
    // Both counts share the day-aligned window boundary of the volume series.
    const expectedCutoff = analyticsWindowStart(NOW, ANALYTICS_WINDOW_DAYS).toISOString();
    const transcripts = chains.voice_call_transcripts as {
      gte: ReturnType<typeof vi.fn>;
      neq: ReturnType<typeof vi.fn>;
    };
    const logs = chains.system_logs as { gte: ReturnType<typeof vi.fn> };
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", expectedCutoff);
    // Missed forwarded calls are counted via their voice_call_blocked ledger
    // row; the answered count must exclude the status='missed' transcript row.
    expect(transcripts.neq).toHaveBeenCalledWith("status", "missed");
    expect(logs.gte).toHaveBeenCalledWith("created_at", expectedCutoff);
  });

  it("returns a null rate when there were no calls at all", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { count: 0, error: null },
      system_logs: { count: null, error: null }
    });
    const stats = await getAnswerRateStats("biz-1", { client, now: NOW });
    expect(stats).toEqual({ answered: 0, missed: 0, rate: null });
  });

  it("treats a null answered count as zero", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { count: null, error: null },
      system_logs: { count: 2, error: null }
    });
    const stats = await getAnswerRateStats("biz-1", { client, now: NOW });
    expect(stats).toEqual({ answered: 0, missed: 2, rate: 0 });
  });

  it("throws when the answered count errors", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { count: null, error: { message: "a down" } },
      system_logs: { count: 0, error: null }
    });
    await expect(getAnswerRateStats("biz-1", { client, now: NOW })).rejects.toThrow(
      "getAnswerRateStats answered: a down"
    );
  });

  it("throws when the missed count errors", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { count: 3, error: null },
      system_logs: { count: null, error: { message: "m down" } }
    });
    await expect(getAnswerRateStats("biz-1", { client, now: NOW })).rejects.toThrow(
      "getAnswerRateStats missed: m down"
    );
  });

  it("defaults to the shared client and window", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { count: 2, error: null },
      system_logs: { count: 0, error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const stats = await getAnswerRateStats("biz-1");
    expect(stats.rate).toBe(1);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
