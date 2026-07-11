import { describe, it, expect, vi, beforeEach } from "vitest";

// The residency read-routing layer is unit-tested in tests/residency-read.test.ts
// and the VPS branch of getAnalyticsDayDetail in tests/residency-read-flip.test.ts.
// Pin CENTRAL mode here so these tests exercise the Supabase path unchanged.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});

import {
  ANALYTICS_CALL_SCAN_LIMIT,
  ANALYTICS_DAY_CALL_LIMIT,
  ANALYTICS_DAY_TEXT_LIMIT,
  ANALYTICS_DAY_TEXT_SCAN_LIMIT,
  ANALYTICS_SEGMENT_CALL_LIMIT,
  ANALYTICS_WINDOW_DAYS,
  analyticsWindowStart,
  computePeriodChange,
  getAnalyticsDayDetail,
  getAnswerRateStats,
  getDailyUsageSeries,
  getHourCallsDetail,
  getInboundCallStats,
  getPreviousPeriodTotals,
  getSentimentCallsDetail,
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

describe("computePeriodChange", () => {
  it("computes signed percent and direction", () => {
    expect(computePeriodChange(30, 20)).toEqual({
      current: 30,
      previous: 20,
      percent: 50,
      direction: "up"
    });
    expect(computePeriodChange(15, 20)).toEqual({
      current: 15,
      previous: 20,
      percent: -25,
      direction: "down"
    });
    expect(computePeriodChange(20, 20)).toEqual({
      current: 20,
      previous: 20,
      percent: 0,
      direction: "flat"
    });
  });

  it("returns a null percent on a zero baseline and rounds to one decimal", () => {
    expect(computePeriodChange(5, 0)).toEqual({
      current: 5,
      previous: 0,
      percent: null,
      direction: "up"
    });
    expect(computePeriodChange(1, 3).percent).toBe(-66.7);
  });
});

describe("getPreviousPeriodTotals", () => {
  it("totals the prior window: calls/minutes from transcripts, texts, refusals", async () => {
    const { client, chains } = makeClient({
      daily_usage: {
        data: [{ sms_sent: 4 }, { sms_sent: null }, { sms_sent: 6 }],
        error: null
      },
      voice_call_transcripts: {
        data: [
          // 120s inbound + 60s outbound + one in-progress inbound (0s).
          {
            started_at: "2026-06-10T10:00:00Z",
            ended_at: "2026-06-10T10:02:00Z",
            direction: "inbound"
          },
          {
            started_at: "2026-06-12T10:00:00Z",
            ended_at: "2026-06-12T10:01:00Z",
            direction: "outbound"
          },
          { started_at: "2026-06-14T10:00:00Z", ended_at: null, direction: "inbound" }
        ],
        error: null
      },
      system_logs: { data: null, count: 3, error: null }
    });

    const totals = await getPreviousPeriodTotals("biz-1", { client, days: 30, now: NOW });
    expect(totals).toEqual({
      calls: 3,
      sms: 10,
      voiceMinutes: 3,
      answered: 2,
      missed: 3,
      answerRate: 2 / 5,
      clipped: false
    });

    // Prior window: [2·30 days ago, 30 days ago) with day-aligned bounds.
    const prevStart = analyticsWindowStart(NOW, 60);
    const currStart = analyticsWindowStart(NOW, 30);
    const usage = chains.daily_usage as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(usage.gte).toHaveBeenCalledWith("usage_date", prevStart.toISOString().slice(0, 10));
    expect(usage.lt).toHaveBeenCalledWith("usage_date", currStart.toISOString().slice(0, 10));
    const transcripts = chains.voice_call_transcripts as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", prevStart.toISOString());
    expect(transcripts.lt).toHaveBeenCalledWith("started_at", currStart.toISOString());
    const logs = chains.system_logs as { eq: ReturnType<typeof vi.fn> };
    expect(logs.eq).toHaveBeenCalledWith("event", "voice_call_blocked");
  });

  it("reports a null answer rate for a quiet prior window and flags clipping", async () => {
    const quiet = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: [], error: null },
      // Null count (PostgREST head-count quirk) coalesces to 0 refusals.
      system_logs: { data: null, count: null, error: null }
    });
    const quietTotals = await getPreviousPeriodTotals("biz-1", {
      client: quiet.client,
      now: NOW
    });
    expect(quietTotals.answerRate).toBeNull();
    expect(quietTotals).toMatchObject({ calls: 0, sms: 0, missed: 0 });

    const full = Array.from({ length: ANALYTICS_CALL_SCAN_LIMIT }, () => ({
      started_at: "2026-06-10T10:00:00Z",
      ended_at: null,
      direction: "outbound"
    }));
    const capped = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: full, error: null },
      system_logs: { data: null, count: 0, error: null }
    });
    const cappedTotals = await getPreviousPeriodTotals("biz-1", {
      client: capped.client,
      now: NOW
    });
    expect(cappedTotals.clipped).toBe(true);
  });

  it("throws on sms / blocked-count query errors", async () => {
    const smsErr = makeClient({
      daily_usage: { data: null, error: { message: "sms down" } },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, count: 0, error: null }
    });
    await expect(
      getPreviousPeriodTotals("biz-1", { client: smsErr.client, now: NOW })
    ).rejects.toThrow("getPreviousPeriodTotals sms: sms down");

    const blockedErr = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, count: null, error: { message: "logs down" } }
    });
    await expect(
      getPreviousPeriodTotals("biz-1", { client: blockedErr.client, now: NOW })
    ).rejects.toThrow("getPreviousPeriodTotals blocked: logs down");
  });

  it("defaults to the shared client, window, and now", async () => {
    const { client } = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, count: 0, error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const totals = await getPreviousPeriodTotals("biz-1");
    expect(totals.calls).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("getDailyUsageSeries", () => {
  it("derives calls + voice minutes from transcripts and texts from daily_usage", async () => {
    const { client, chains } = makeClient({
      // sms_sent is the only daily_usage column with a live writer.
      daily_usage: {
        data: [
          { usage_date: "2026-07-03", sms_sent: 10 },
          { usage_date: "2026-07-04", sms_sent: null }
        ],
        error: null
      },
      voice_call_transcripts: {
        data: [
          // 150s + an in-progress call (0s) on the 3rd; 40s on the 4th.
          { started_at: "2026-07-03T10:00:00Z", ended_at: "2026-07-03T10:02:30Z" },
          { started_at: "2026-07-03T22:00:00Z", ended_at: null },
          { started_at: "2026-07-04T01:00:00Z", ended_at: "2026-07-04T01:00:40Z" },
          // Clock-skewed (end before start) and unparseable ends count the
          // call but contribute zero minutes.
          { started_at: "2026-07-02T05:00:00Z", ended_at: "2026-07-02T04:00:00Z" },
          { started_at: "2026-07-02T06:00:00Z", ended_at: "garbage" }
        ],
        error: null
      }
    });

    const series = await getDailyUsageSeries("biz-1", { client, days: 3, now: NOW });

    expect(series.days).toEqual([
      { date: "2026-07-02", calls: 2, sms: 0, voiceMinutes: 0 },
      { date: "2026-07-03", calls: 2, sms: 10, voiceMinutes: 3 },
      { date: "2026-07-04", calls: 1, sms: 0, voiceMinutes: 1 }
    ]);
    expect(series.totals).toEqual({ calls: 5, sms: 10, voiceMinutes: 4 });
    expect(series.clipped).toBe(false);
    const usage = chains.daily_usage as { gte: ReturnType<typeof vi.fn> };
    expect(usage.gte).toHaveBeenCalledWith("usage_date", "2026-07-02");
    // Transcript scan shares the same day-aligned boundary.
    const transcripts = chains.voice_call_transcripts as {
      gte: ReturnType<typeof vi.fn>;
      neq: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", "2026-07-02T00:00:00.000Z");
    expect(transcripts.neq).toHaveBeenCalledWith("status", "missed");
    expect(transcripts.limit).toHaveBeenCalledWith(ANALYTICS_CALL_SCAN_LIMIT);
  });

  it("handles null data payloads", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: null, error: null }
    });
    const series = await getDailyUsageSeries("biz-1", { client, days: 2, now: NOW });
    expect(series.days).toHaveLength(2);
    expect(series.totals).toEqual({ calls: 0, sms: 0, voiceMinutes: 0 });
  });

  it("flags the series as clipped when the transcript scan hits the row cap", async () => {
    const full = Array.from({ length: ANALYTICS_CALL_SCAN_LIMIT }, (_, i) => ({
      started_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
      ended_at: null
    }));
    const { client } = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: full, error: null }
    });
    const series = await getDailyUsageSeries("biz-1", { client, now: NOW });
    expect(series.clipped).toBe(true);
  });

  it("throws on daily_usage query error", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: { message: "boom" } },
      voice_call_transcripts: { data: [], error: null }
    });
    await expect(getDailyUsageSeries("biz-1", { client, now: NOW })).rejects.toThrow(
      "getDailyUsageSeries: boom"
    );
  });

  it("throws on transcript scan error", async () => {
    const { client } = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: null, error: { message: "scan down" } }
    });
    await expect(getDailyUsageSeries("biz-1", { client, now: NOW })).rejects.toThrow(
      "getDailyUsageSeries calls: scan down"
    );
  });

  it("defaults to the shared client, window, and now", async () => {
    const { client } = makeClient({
      daily_usage: { data: [], error: null },
      voice_call_transcripts: { data: [], error: null }
    });
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

  /** Telnyx inbound envelope with the given sender + text. */
  const jobPayload = (from: string, text: string) => ({
    data: { payload: { from: { phone_number: from }, text } }
  });

  const emptyTables = {
    daily_usage: { data: null, error: null },
    voice_call_transcripts: { data: [], error: null },
    system_logs: { count: 0, error: null },
    sms_inbound_jobs: { data: [], error: null },
    sms_outbound_log: { data: [], error: null }
  };

  it("returns the day's derived usage, calls, and turned-away count", async () => {
    const { client, chains } = makeClient({
      ...emptyTables,
      daily_usage: { data: { sms_sent: 10 }, error: null },
      voice_call_transcripts: {
        data: [
          // 300s
          CALL,
          {
            ...CALL,
            id: "t-2",
            // 60s
            ended_at: "2026-07-03T09:16:00Z",
            call_kind: "forwarded",
            forwarded_to_e164: "+15559998888",
            summary: null,
            // Unknown sentiment strings are dropped rather than rendered.
            sentiment: "confused"
          },
          // In progress — counts as a call, contributes no minutes.
          { ...CALL, id: "t-3", ended_at: null, sentiment: null }
        ],
        error: null
      },
      system_logs: { count: 2, error: null }
    });

    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });

    expect(detail.date).toBe(DAY);
    // Calls + minutes come from the fetched transcripts (daily_usage's call
    // columns have no writer); texts stay on daily_usage.sms_sent.
    expect(detail.usage).toEqual({ calls: 3, sms: 10, voiceMinutes: 6 });
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

    // The day is sliced [00:00 UTC, next 00:00 UTC) — same bucketing as the series.
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
    // Scanned at the series' row cap so the header totals match the chart bar.
    expect(transcripts.limit).toHaveBeenCalledWith(ANALYTICS_CALL_SCAN_LIMIT);
    const logs = chains.system_logs as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(logs.gte).toHaveBeenCalledWith("created_at", "2026-07-03T00:00:00.000Z");
    expect(logs.lt).toHaveBeenCalledWith("created_at", "2026-07-04T00:00:00.000Z");
  });

  it("expands the day's texts from inbound jobs + the outbound log, newest first", async () => {
    const { client, chains } = makeClient({
      ...emptyTables,
      sms_inbound_jobs: {
        data: [
          // Inbound + reply, both inside the day. RCS inbound answered on SMS.
          {
            id: "j-1",
            payload: jobPayload("+15550001111", "Are you open today?"),
            status: "done",
            assistant_reply_text: "Yes, until 5pm!",
            rowboat_reply_cached: null,
            channel: "rcs",
            reply_channel: "sms",
            created_at: "2026-07-03T09:00:00Z",
            updated_at: "2026-07-03T09:00:30Z"
          },
          // Job created the PREVIOUS day whose reply landed inside the day —
          // only the outbound message is attributed to this day.
          {
            id: "j-2",
            payload: jobPayload("+15550002222", "Quote please"),
            status: "done",
            assistant_reply_text: null,
            rowboat_reply_cached: "Sent you a quote.",
            channel: null,
            reply_channel: "rcs",
            created_at: "2026-07-02T23:50:00Z",
            updated_at: "2026-07-03T00:10:00Z"
          },
          // Unparseable envelope with no reply — contributes nothing.
          {
            id: "j-3",
            payload: {},
            status: "pending",
            assistant_reply_text: null,
            rowboat_reply_cached: null,
            channel: null,
            reply_channel: null,
            created_at: "2026-07-03T11:00:00Z",
            updated_at: null
          },
          // Unparseable envelope WITH a reply — the outbound renders with no
          // linkable customer number.
          {
            id: "j-4",
            payload: {},
            status: "done",
            assistant_reply_text: "Following up.",
            rowboat_reply_cached: null,
            channel: null,
            reply_channel: null,
            created_at: "2026-07-03T11:30:00Z",
            updated_at: "2026-07-03T11:30:05Z"
          },
          // Created inside the day but replied AFTER it — only the inbound
          // side belongs to this day.
          {
            id: "j-5",
            payload: jobPayload("+15550005555", "Late question"),
            status: "done",
            assistant_reply_text: "Answered next day.",
            rowboat_reply_cached: null,
            channel: null,
            reply_channel: null,
            created_at: "2026-07-03T23:00:00Z",
            updated_at: "2026-07-04T00:05:00Z"
          }
        ],
        error: null
      },
      sms_outbound_log: {
        data: [
          {
            id: "o-1",
            to_e164: "+15550003333",
            body: "Your appointment is confirmed.",
            source: "ai_flow",
            channel: null,
            created_at: "2026-07-03T10:00:00Z"
          },
          {
            id: "o-2",
            to_e164: "+15550004444",
            body: "Rich card follow-up.",
            source: "owner_manual",
            channel: "rcs",
            created_at: "2026-07-03T12:00:00Z"
          }
        ],
        error: null
      }
    });

    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });

    expect(detail.texts.map((t) => t.id)).toEqual([
      "j-5:inbound",
      "o-2:flow-outbound",
      "j-4:outbound",
      "o-1:flow-outbound",
      "j-1:outbound",
      "j-1:inbound",
      "j-2:outbound"
    ]);
    expect(detail.texts[1]).toMatchObject({ channel: "rcs", source: "owner_manual" });
    expect(detail.texts[2]).toMatchObject({
      direction: "outbound",
      otherE164: null,
      content: "Following up."
    });
    expect(detail.texts[3]).toEqual({
      id: "o-1:flow-outbound",
      direction: "outbound",
      otherE164: "+15550003333",
      content: "Your appointment is confirmed.",
      timestamp: "2026-07-03T10:00:00Z",
      source: "ai_flow",
      channel: "sms"
    });
    expect(detail.texts[4]).toMatchObject({ direction: "outbound", channel: "sms" });
    expect(detail.texts[5]).toMatchObject({
      direction: "inbound",
      otherE164: "+15550001111",
      channel: "rcs"
    });
    expect(detail.texts[6]).toMatchObject({
      direction: "outbound",
      content: "Sent you a quote.",
      channel: "rcs"
    });
    expect(detail.textsClipped).toBe(false);

    // Jobs are scanned from a day EARLIER so replies landing in this day are
    // caught; the outbound log is sliced to the day directly.
    const jobs = chains.sms_inbound_jobs as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(jobs.gte).toHaveBeenCalledWith("created_at", "2026-07-02T00:00:00.000Z");
    expect(jobs.lt).toHaveBeenCalledWith("created_at", "2026-07-04T00:00:00.000Z");
    const outbound = chains.sms_outbound_log as {
      gte: ReturnType<typeof vi.fn>;
      lt: ReturnType<typeof vi.fn>;
    };
    expect(outbound.gte).toHaveBeenCalledWith("created_at", "2026-07-03T00:00:00.000Z");
    expect(outbound.lt).toHaveBeenCalledWith("created_at", "2026-07-04T00:00:00.000Z");
  });

  it("caps the text list and flags it clipped", async () => {
    // 101 jobs × 2 messages each = 202 expanded texts > the 200 display cap.
    const jobs = Array.from({ length: 101 }, (_, i) => ({
      id: `j-${i}`,
      payload: jobPayload("+15550001111", `msg ${i}`),
      status: "done",
      assistant_reply_text: `reply ${i}`,
      rowboat_reply_cached: null,
      channel: null,
      reply_channel: null,
      created_at: `2026-07-03T09:${String(i % 60).padStart(2, "0")}:00Z`,
      updated_at: `2026-07-03T09:${String(i % 60).padStart(2, "0")}:01Z`
    }));
    const { client } = makeClient({
      ...emptyTables,
      sms_inbound_jobs: { data: jobs, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.texts).toHaveLength(ANALYTICS_DAY_TEXT_LIMIT);
    expect(detail.textsClipped).toBe(true);
  });

  it("flags texts clipped when the inbound-jobs scan fills its row cap", async () => {
    // 1000 rows hit the scan cap even though none expand into messages —
    // same-day messages may exist beyond the scan, so the flag must be set.
    const jobs = Array.from({ length: ANALYTICS_DAY_TEXT_SCAN_LIMIT }, (_, i) => ({
      id: `j-${i}`,
      payload: {},
      status: "pending",
      assistant_reply_text: null,
      rowboat_reply_cached: null,
      channel: null,
      reply_channel: null,
      created_at: "2026-07-03T09:00:00Z",
      updated_at: null
    }));
    const { client } = makeClient({
      ...emptyTables,
      sms_inbound_jobs: { data: jobs, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.texts).toEqual([]);
    expect(detail.textsClipped).toBe(true);
  });

  it("flags texts clipped when the outbound-log scan fills its row cap", async () => {
    const outbound = Array.from({ length: ANALYTICS_DAY_TEXT_SCAN_LIMIT }, (_, i) => ({
      id: `o-${i}`,
      to_e164: "+15550001111",
      body: `send ${i}`,
      source: "ai_flow",
      channel: null,
      created_at: "2026-07-03T09:00:00Z"
    }));
    const { client } = makeClient({
      ...emptyTables,
      sms_outbound_log: { data: outbound, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.texts).toHaveLength(ANALYTICS_DAY_TEXT_LIMIT);
    expect(detail.textsClipped).toBe(true);
  });

  it("zero-fills when the day has no usage row, calls, texts, or blocked count", async () => {
    const { client } = makeClient({
      daily_usage: { data: null, error: null },
      voice_call_transcripts: { data: null, error: null },
      system_logs: { count: null, error: null },
      sms_inbound_jobs: { data: null, error: null },
      sms_outbound_log: { data: null, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.usage).toEqual({ calls: 0, sms: 0, voiceMinutes: 0 });
    expect(detail.calls).toEqual([]);
    expect(detail.texts).toEqual([]);
    expect(detail.turnedAway).toBe(0);
    expect(detail.clipped).toBe(false);
    expect(detail.textsClipped).toBe(false);
  });

  it("ignores unparseable call timestamps when deriving minutes", async () => {
    const { client } = makeClient({
      ...emptyTables,
      voice_call_transcripts: {
        data: [{ ...CALL, id: "t-x", started_at: "garbage", ended_at: "2026-07-03T09:00:00Z" }],
        error: null
      }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.usage.calls).toBe(1);
    expect(detail.usage.voiceMinutes).toBe(0);
  });

  it("drops texts with unparseable timestamps", async () => {
    const { client } = makeClient({
      ...emptyTables,
      sms_inbound_jobs: {
        data: [
          {
            id: "j-x",
            payload: jobPayload("+15550001111", "hello"),
            status: "done",
            assistant_reply_text: null,
            rowboat_reply_cached: null,
            channel: null,
            reply_channel: null,
            created_at: "garbage",
            updated_at: null
          }
        ],
        error: null
      }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.texts).toEqual([]);
  });

  it("treats a null sms_sent as zero", async () => {
    const { client } = makeClient({
      ...emptyTables,
      daily_usage: { data: { sms_sent: null }, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.usage.sms).toBe(0);
  });

  it("caps the call LIST at the display limit while totals count the full scan", async () => {
    const full = Array.from({ length: ANALYTICS_DAY_CALL_LIMIT + 1 }, (_, i) => ({
      ...CALL,
      id: `t-${i}`
    }));
    const { client } = makeClient({
      ...emptyTables,
      voice_call_transcripts: { data: full, error: null }
    });
    const detail = await getAnalyticsDayDetail("biz-1", DAY, { client });
    expect(detail.clipped).toBe(true);
    expect(detail.calls).toHaveLength(ANALYTICS_DAY_CALL_LIMIT);
    // Header totals reflect every scanned call, matching the chart bar.
    expect(detail.usage.calls).toBe(ANALYTICS_DAY_CALL_LIMIT + 1);
  });

  it("throws when the usage lookup errors", async () => {
    const { client } = makeClient({
      ...emptyTables,
      daily_usage: { data: null, error: { message: "u down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail usage: u down"
    );
  });

  it("throws when the call scan errors", async () => {
    const { client } = makeClient({
      ...emptyTables,
      voice_call_transcripts: { data: null, error: { message: "c down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail calls: c down"
    );
  });

  it("throws when the blocked count errors", async () => {
    const { client } = makeClient({
      ...emptyTables,
      system_logs: { count: null, error: { message: "b down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail blocked: b down"
    );
  });

  it("throws when the inbound-jobs scan errors", async () => {
    const { client } = makeClient({
      ...emptyTables,
      sms_inbound_jobs: { data: null, error: { message: "j down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail texts: j down"
    );
  });

  it("throws when the outbound-log scan errors", async () => {
    const { client } = makeClient({
      ...emptyTables,
      sms_outbound_log: { data: null, error: { message: "o down" } }
    });
    await expect(getAnalyticsDayDetail("biz-1", DAY, { client })).rejects.toThrow(
      "getAnalyticsDayDetail outbound texts: o down"
    );
  });

  it("defaults to the shared client", async () => {
    const { client } = makeClient(emptyTables);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const detail = await getAnalyticsDayDetail("biz-1", DAY);
    expect(detail.calls).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("getSentimentCallsDetail", () => {
  const CALL = {
    id: "t-9",
    caller_e164: "+15550001111",
    started_at: "2026-07-03T09:15:00Z",
    ended_at: "2026-07-03T09:20:00Z",
    status: "completed",
    direction: "inbound",
    call_kind: "ai",
    forwarded_to_e164: null,
    summary: "Asked about hours.",
    sentiment: "neutral"
  };

  it("lists the window's inbound calls with the given sentiment", async () => {
    const { client, chains } = makeClient({
      voice_call_transcripts: { data: [CALL], error: null }
    });
    const detail = await getSentimentCallsDetail("biz-1", "neutral", { client, now: NOW });
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0]).toMatchObject({
      id: "t-9",
      sentiment: "neutral",
      summary: "Asked about hours."
    });
    expect(detail.clipped).toBe(false);
    // Same population as the sentiment mix: inbound only, sentiment-filtered,
    // window-aligned.
    const expectedCutoff = analyticsWindowStart(NOW, ANALYTICS_WINDOW_DAYS).toISOString();
    const transcripts = chains.voice_call_transcripts as {
      eq: ReturnType<typeof vi.fn>;
      gte: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(transcripts.eq).toHaveBeenCalledWith("direction", "inbound");
    expect(transcripts.eq).toHaveBeenCalledWith("sentiment", "neutral");
    expect(transcripts.gte).toHaveBeenCalledWith("started_at", expectedCutoff);
    expect(transcripts.limit).toHaveBeenCalledWith(ANALYTICS_SEGMENT_CALL_LIMIT);
  });

  it("flags the list as clipped at the row cap", async () => {
    const full = Array.from({ length: ANALYTICS_SEGMENT_CALL_LIMIT }, (_, i) => ({
      ...CALL,
      id: `t-${i}`
    }));
    const { client } = makeClient({
      voice_call_transcripts: { data: full, error: null }
    });
    const detail = await getSentimentCallsDetail("biz-1", "neutral", { client, now: NOW });
    expect(detail.clipped).toBe(true);
  });

  it("throws on scan error", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: null, error: { message: "s down" } }
    });
    await expect(
      getSentimentCallsDetail("biz-1", "neutral", { client, now: NOW })
    ).rejects.toThrow("getSentimentCallsDetail: s down");
  });

  it("defaults to the shared client and window", async () => {
    const { client } = makeClient({ voice_call_transcripts: { data: [], error: null } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const detail = await getSentimentCallsDetail("biz-1", "positive");
    expect(detail.calls).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("getHourCallsDetail", () => {
  const call = (id: string, startedAt: string) => ({
    id,
    caller_e164: "+15550001111",
    started_at: startedAt,
    ended_at: null,
    status: "completed",
    direction: "inbound",
    call_kind: "ai",
    forwarded_to_e164: null,
    summary: null,
    sentiment: null
  });

  it("filters the window's calls to the hour in the business timezone", async () => {
    const { client } = makeClient({
      voice_call_transcripts: {
        data: [
          // 19:30 UTC = 12:30 in Phoenix — matches hour 12.
          call("t-1", "2026-07-04T19:30:00Z"),
          // 20:30 UTC = 13:30 in Phoenix — does not match.
          call("t-2", "2026-07-04T20:30:00Z")
        ],
        error: null
      },
      system_logs: {
        data: [
          // 19:50 UTC = 12:50 Phoenix — a turned-away attempt in the hour.
          { created_at: "2026-07-04T19:50:00Z" },
          { created_at: "2026-07-04T08:00:00Z" }
        ],
        error: null
      }
    });
    const detail = await getHourCallsDetail("biz-1", 12, {
      client,
      now: NOW,
      timeZone: "America/Phoenix"
    });
    expect(detail.calls.map((c) => c.id)).toEqual(["t-1"]);
    expect(detail.turnedAway).toBe(1);
    expect(detail.clipped).toBe(false);
  });

  it("flags the list as clipped when the scan hits the row cap", async () => {
    const full = Array.from({ length: ANALYTICS_CALL_SCAN_LIMIT }, (_, i) =>
      call(`t-${i}`, "2026-07-04T09:15:00Z")
    );
    const { client } = makeClient({
      voice_call_transcripts: { data: full, error: null },
      system_logs: { data: [], error: null }
    });
    const detail = await getHourCallsDetail("biz-1", 9, { client, now: NOW });
    // 2000 in-hour matches also exceed the 200-row display cap.
    expect(detail.calls).toHaveLength(ANALYTICS_SEGMENT_CALL_LIMIT);
    expect(detail.clipped).toBe(true);
  });

  it("flags the list as clipped when the blocked scan hits the row cap", async () => {
    const blocked = Array.from({ length: ANALYTICS_CALL_SCAN_LIMIT }, (_, i) => ({
      created_at: new Date(NOW.getTime() - i * 60_000).toISOString()
    }));
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: blocked, error: null }
    });
    const detail = await getHourCallsDetail("biz-1", 9, { client, now: NOW });
    expect(detail.clipped).toBe(true);
  });

  it("handles null blocked data", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, error: null }
    });
    const detail = await getHourCallsDetail("biz-1", 9, { client, now: NOW });
    expect(detail.calls).toEqual([]);
    expect(detail.turnedAway).toBe(0);
    expect(detail.clipped).toBe(false);
  });

  it("throws on transcript scan error", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: null, error: { message: "h down" } },
      system_logs: { data: [], error: null }
    });
    await expect(getHourCallsDetail("biz-1", 9, { client, now: NOW })).rejects.toThrow(
      "getHourCallsDetail: h down"
    );
  });

  it("throws on blocked scan error", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: null, error: { message: "hb down" } }
    });
    await expect(getHourCallsDetail("biz-1", 9, { client, now: NOW })).rejects.toThrow(
      "getHourCallsDetail blocked: hb down"
    );
  });

  it("defaults to the shared client and window", async () => {
    const { client } = makeClient({
      voice_call_transcripts: { data: [], error: null },
      system_logs: { data: [], error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const detail = await getHourCallsDetail("biz-1", 9);
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
