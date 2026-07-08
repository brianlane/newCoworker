import { beforeEach, describe, expect, it, vi } from "vitest";

// The routing layer is unit-tested in tests/residency-read.test.ts; here it
// is mocked so each wired db module's VPS branch can be pinned in isolation
// (and so no residency-mode lookup interferes with the central-path tests
// that live in the modules' own suites).
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return {
    ...actual,
    isVpsReadMode: vi.fn(),
    readMovedRows: vi.fn(),
    countMovedRows: vi.fn()
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("central client must not be constructed on the VPS read path");
  })
}));

import {
  countMovedRows,
  isVpsReadMode,
  readMovedRows
} from "@/lib/residency/read";
import { listEmailLog, listEmailLogForAddress, getEmailBody } from "@/lib/db/email-log";
import { getNotifications, getUnreadNotificationCount } from "@/lib/db/notifications";
import {
  getTranscriptByCallControlId,
  getTranscriptById,
  listTranscriptsForBusiness,
  listTranscriptsForCaller,
  listTurns,
  listVoiceTurnsForCustomer
} from "@/lib/db/voice-transcripts";
import { listConversationsForBusiness, listMessagesForCustomer } from "@/lib/db/sms-history";
import {
  getAnalyticsDayDetail,
  getAnswerRateStats,
  getDailyUsageSeries,
  getHourCallsDetail,
  getInboundCallStats,
  getSentimentCallsDetail
} from "@/lib/analytics/dashboard-analytics";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** A db stub for functions that still read a CENTRAL table on the vps path. */
function centralDb(tables: Record<string, unknown[]>) {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => ({ data: tables[table] ?? [], error: null }));
    return chain;
  };
  return { from: vi.fn((t: string) => builder(t)) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVpsReadMode).mockResolvedValue(true);
  vi.mocked(readMovedRows).mockResolvedValue([]);
  vi.mocked(countMovedRows).mockResolvedValue(0);
});

describe("email-log vps reads", () => {
  it("listEmailLog routes to the box with the projected columns", async () => {
    const rows = [{ id: "e1", created_at: "2026-07-07T00:00:00Z" }];
    vi.mocked(readMovedRows).mockResolvedValue(rows as never);
    expect(await listEmailLog(BIZ, { limit: 10 }, centralDb({}))).toEqual(rows);
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "email_log",
      columns: expect.arrayContaining(["id", "body_preview", "created_at"]),
      filters: [{ column: "business_id", op: "eq", value: BIZ }],
      order: [{ column: "created_at", ascending: false }],
      limit: 10
    });
  });

  it("listEmailLogForAddress merges from/to selects, dedupes, sorts, limits", async () => {
    const addr = "joe_smith@x.com";
    const a = { id: "e1", created_at: "2026-07-01T00:00:00Z", from_email: addr, to_email: null };
    const b = { id: "e2", created_at: "2026-07-03T00:00:00Z", from_email: null, to_email: "JOE_SMITH@X.COM" };
    const c = { id: "e3", created_at: "2026-07-02T00:00:00Z", from_email: addr, to_email: null };
    const dupe = { id: "e1", created_at: "2026-07-01T00:00:00Z", from_email: addr, to_email: null };
    // A wildcard near-miss (joeXsmith) that a broken ILIKE-escape would let
    // through — the JS exact-match post-filter must drop it.
    const nearMiss = {
      id: "e9",
      created_at: "2026-07-04T00:00:00Z",
      from_email: "joeXsmith@x.com",
      to_email: null
    };
    // Merge order e2, e1, e3 makes the desc sort exercise BOTH comparator
    // directions (e1 sorts after e2, e3 sorts before e1).
    vi.mocked(readMovedRows)
      .mockResolvedValueOnce([b, nearMiss] as never)
      .mockResolvedValueOnce([a, c, dupe] as never);
    const rows = await listEmailLogForAddress(BIZ, "joe_smith@x.com", { limit: 2 }, centralDb({}));
    expect(rows.map((r) => r.id)).toEqual(["e2", "e3"]);
    // LIKE metachars in the local-part are escaped for the box's ILIKE.
    const calls = vi.mocked(readMovedRows).mock.calls;
    expect(calls[0][1]).toMatchObject({
      filters: expect.arrayContaining([
        { column: "from_email", op: "ilike", value: "joe\\_smith@x.com" }
      ])
    });
    expect(calls[1][1]).toMatchObject({
      filters: expect.arrayContaining([
        { column: "to_email", op: "ilike", value: "joe\\_smith@x.com" }
      ])
    });
  });

  it("getEmailBody returns the box row or null, defaulting attachments", async () => {
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      { body_preview: "p", body_full: "f", attachments: null }
    ] as never);
    expect(await getEmailBody(BIZ, "e1", centralDb({}))).toEqual({
      body_preview: "p",
      body_full: "f",
      attachments: []
    });
    const att = [{ filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1, storage_path: "p" }];
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      { body_preview: null, body_full: null, attachments: att }
    ] as never);
    expect((await getEmailBody(BIZ, "e2", centralDb({})))?.attachments).toEqual(att);
    vi.mocked(readMovedRows).mockResolvedValueOnce([] as never);
    expect(await getEmailBody(BIZ, "e404", centralDb({}))).toBeNull();
  });
});

describe("notifications vps reads", () => {
  it("getNotifications routes with the unreadOnly filter when asked", async () => {
    await getNotifications(BIZ, { limit: 5, unreadOnly: true }, centralDb({}));
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "notifications",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "read_at", op: "is", value: null }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 5
    });
    await getNotifications(BIZ, 7, centralDb({}));
    expect(vi.mocked(readMovedRows).mock.calls[1][1]).toMatchObject({
      filters: [{ column: "business_id", op: "eq", value: BIZ }],
      limit: 7
    });
    // Options object with no limit falls back to the default 20.
    await getNotifications(BIZ, {}, centralDb({}));
    expect(vi.mocked(readMovedRows).mock.calls[2][1]).toMatchObject({ limit: 20 });
  });

  it("getUnreadNotificationCount counts sent+unread on the box", async () => {
    vi.mocked(countMovedRows).mockResolvedValue(3);
    expect(await getUnreadNotificationCount(BIZ, centralDb({}))).toBe(3);
    expect(countMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "notifications",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "status", op: "eq", value: "sent" },
        { column: "read_at", op: "is", value: null }
      ]
    });
  });
});

describe("voice-transcripts vps reads", () => {
  it("list/getByCallControlId/getById route to the box", async () => {
    await listTranscriptsForBusiness(BIZ, { limit: 3 }, centralDb({}));
    expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
      table: "voice_call_transcripts",
      limit: 3
    });

    vi.mocked(readMovedRows).mockResolvedValueOnce([{ id: "t1" }] as never);
    expect(await getTranscriptByCallControlId(BIZ, "v3:abc", centralDb({}))).toEqual({
      id: "t1"
    });
    vi.mocked(readMovedRows).mockResolvedValueOnce([] as never);
    expect(await getTranscriptByCallControlId(BIZ, "v3:miss", centralDb({}))).toBeNull();
    vi.mocked(readMovedRows).mockResolvedValueOnce([{ id: "t2" }] as never);
    expect(await getTranscriptById(BIZ, "t2", centralDb({}))).toEqual({ id: "t2" });
    vi.mocked(readMovedRows).mockResolvedValueOnce([] as never);
    expect(await getTranscriptById(BIZ, "t404", centralDb({}))).toBeNull();
  });

  it("central mode keeps single-row and caller lookups on Supabase", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(false);
    const maybeSingle = vi.fn(async () => ({ data: { id: "t-central" }, error: null }));
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = maybeSingle;
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(async () => ({ data: [{ id: "t-central" }], error: null }));
    const db = { from: vi.fn(() => chain) } as never;
    expect(await getTranscriptByCallControlId(BIZ, "v3:abc", db)).toEqual({ id: "t-central" });
    expect(await getTranscriptById(BIZ, "t1", db)).toEqual({ id: "t-central" });
    expect(await listTranscriptsForCaller(BIZ, "+1555", {}, db)).toEqual([
      { id: "t-central" }
    ]);
    expect(readMovedRows).not.toHaveBeenCalled();
  });

  it("listTurns routes only when the caller supplies the business id", async () => {
    vi.mocked(readMovedRows).mockResolvedValueOnce([{ id: 1 }] as never);
    expect(await listTurns("t1", { businessId: BIZ }, centralDb({}))).toEqual([{ id: 1 }]);
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "voice_call_transcript_turns",
      filters: [{ column: "transcript_id", op: "eq", value: "t1" }],
      order: [{ column: "turn_index", ascending: true }]
    });

    // Without a businessId the read stays central (documented until B4).
    const centralChain = () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = vi.fn(() => chain);
      chain.order = vi.fn(async () => ({ data: [], error: null }));
      return { from: vi.fn(() => chain) } as never;
    };
    expect(await listTurns("t1", {}, centralChain())).toEqual([]);

    // And with a businessId whose tenant is NOT in vps mode, central too.
    vi.mocked(isVpsReadMode).mockResolvedValueOnce(false);
    expect(await listTurns("t1", { businessId: BIZ }, centralChain())).toEqual([]);
  });

  it("listTranscriptsForCaller folds aliases into one IN filter with central null ordering", async () => {
    await listTranscriptsForCaller(BIZ, "+1555", { aliases: ["+1556", "+1555"] }, centralDb({}));
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "voice_call_transcripts",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "caller_e164", op: "in", value: ["+1555", "+1556"] }
      ],
      // nullsFirst:false mirrors the central supabase-js ordering exactly.
      order: [{ column: "started_at", ascending: false, nullsFirst: false }],
      limit: 25
    });
  });

  it("listVoiceTurnsForCustomer bulk-reads turns for the caller's transcripts", async () => {
    vi.mocked(readMovedRows)
      // transcripts for caller
      .mockResolvedValueOnce([
        { id: "t1", started_at: "2026-07-01T00:00:00Z" },
        { id: "t2", started_at: "2026-07-02T00:00:00Z" }
      ] as never)
      // turns bulk read
      .mockResolvedValueOnce([
        { transcript_id: "t2", role: "caller", content: "hi", started_at: null, turn_index: 0 },
        {
          transcript_id: "t1",
          role: "assistant",
          content: "hello",
          started_at: "2026-07-01T00:00:00Z",
          turn_index: 0
        }
      ] as never);
    const turns = await listVoiceTurnsForCustomer(BIZ, "+1555", {}, centralDb({}));
    // Chronological by call start (t1 before t2), started_at falling back to
    // the transcript's own start.
    expect(turns.map((t) => t.transcriptId)).toEqual(["t1", "t2"]);
    expect(turns[1].callStartedAt).toBe("2026-07-02T00:00:00Z");
    expect(vi.mocked(readMovedRows).mock.calls[1][1]).toMatchObject({
      table: "voice_call_transcript_turns",
      filters: [{ column: "transcript_id", op: "in", value: ["t1", "t2"] }]
    });
  });
});

describe("analytics vps reads", () => {
  const NOW = new Date("2026-07-04T12:00:00Z");

  /**
   * Db stub for the tables the analytics lib still reads centrally on the
   * vps path: `daily_usage` (maybeSingle / thenable list), `system_logs`
   * (thenable head count or list), and `sms_inbound_jobs` (thenable list) —
   * all control-plane/engine tables that never move to the box.
   */
  function analyticsCentralDb(resultsByTable: Record<string, unknown> = {}) {
    const builder = (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "lt", "order", "limit"]) {
        chain[m] = vi.fn(() => chain);
      }
      chain.maybeSingle = vi.fn(async () => ({
        data: (resultsByTable[table] as Record<string, unknown>) ?? null,
        error: null
      }));
      (chain as { then: unknown }).then = (
        onF: (v: unknown) => unknown,
        onR: (e: unknown) => unknown
      ) =>
        Promise.resolve(
          resultsByTable[table] ?? { data: [], count: 1, error: null }
        ).then(onF, onR);
      return chain;
    };
    return { from: vi.fn((t: string) => builder(t)) } as never;
  }

  /** readMovedRows stub dispatching per moved table. */
  function dispatchMovedRows(rowsByTable: Record<string, unknown[]>) {
    vi.mocked(readMovedRows).mockImplementation(async (_biz, request) => {
      return (rowsByTable[(request as { table: string }).table] ?? []) as never;
    });
  }

  const BOX_CALL = {
    id: "t1",
    caller_e164: "+1555",
    started_at: "2026-07-03T09:00:00Z",
    ended_at: "2026-07-03T09:05:00Z",
    status: "completed",
    direction: "inbound",
    call_kind: "ai",
    forwarded_to_e164: null,
    summary: "Neutral chat.",
    sentiment: "neutral"
  };

  it("day detail reads calls + outbound texts from the box; the rest central", async () => {
    dispatchMovedRows({
      voice_call_transcripts: [BOX_CALL],
      sms_outbound_log: [
        {
          id: "o1",
          to_e164: "+1777",
          body: "hi",
          source: "ai_flow",
          channel: null,
          created_at: "2026-07-03T10:00:00Z"
        }
      ]
    });

    const detail = await getAnalyticsDayDetail(BIZ, "2026-07-03", {
      client: analyticsCentralDb({ daily_usage: { sms_sent: 5 } })
    });

    // calls + minutes derive from the box transcripts; sms from central.
    expect(detail.usage).toEqual({ calls: 1, sms: 5, voiceMinutes: 5 });
    expect(detail.turnedAway).toBe(1);
    expect(detail.calls[0]).toMatchObject({ id: "t1", sentiment: "neutral" });
    expect(detail.texts[0]).toMatchObject({ id: "o1:flow-outbound", otherE164: "+1777" });

    const calls = vi.mocked(readMovedRows).mock.calls;
    expect(calls[0][1]).toMatchObject({
      table: "voice_call_transcripts",
      columns: expect.arrayContaining(["id", "caller_e164", "started_at", "sentiment"]),
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "status", op: "neq", value: "missed" },
        { column: "started_at", op: "gte", value: "2026-07-03T00:00:00.000Z" },
        { column: "started_at", op: "lt", value: "2026-07-04T00:00:00.000Z" }
      ],
      order: [{ column: "started_at", ascending: false }],
      limit: 200
    });
    expect(calls[1][1]).toMatchObject({
      table: "sms_outbound_log",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "created_at", op: "gte", value: "2026-07-03T00:00:00.000Z" },
        { column: "created_at", op: "lt", value: "2026-07-04T00:00:00.000Z" }
      ]
    });
  });

  it("daily series derives calls/minutes from box transcripts", async () => {
    dispatchMovedRows({ voice_call_transcripts: [BOX_CALL] });
    const series = await getDailyUsageSeries(BIZ, {
      client: analyticsCentralDb({ daily_usage: { data: [], error: null } }),
      days: 3,
      now: NOW
    });
    expect(series.totals).toEqual({ calls: 1, sms: 0, voiceMinutes: 5 });
    // Open-ended trailing window: gte only, no lt filter.
    expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
      table: "voice_call_transcripts",
      columns: ["started_at", "ended_at"],
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "status", op: "neq", value: "missed" },
        { column: "started_at", op: "gte", value: "2026-07-02T00:00:00.000Z" }
      ]
    });
  });

  it("inbound stats scan box transcripts with the inbound direction filter", async () => {
    dispatchMovedRows({
      voice_call_transcripts: [{ started_at: "2026-07-03T09:00:00Z", sentiment: "neutral" }]
    });
    const stats = await getInboundCallStats(BIZ, {
      client: analyticsCentralDb({ system_logs: { data: [], error: null } }),
      now: NOW
    });
    expect(stats.callCount).toBe(1);
    expect(stats.sentiment.neutral).toBe(1);
    expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
      table: "voice_call_transcripts",
      columns: ["started_at", "sentiment"],
      filters: expect.arrayContaining([{ column: "direction", op: "eq", value: "inbound" }])
    });
  });

  it("answer rate counts answered calls on the box", async () => {
    vi.mocked(countMovedRows).mockResolvedValue(9);
    const stats = await getAnswerRateStats(BIZ, {
      client: analyticsCentralDb({ system_logs: { count: 1, error: null } }),
      now: NOW
    });
    expect(stats).toEqual({ answered: 9, missed: 1, rate: 0.9 });
    expect(countMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "voice_call_transcripts",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "direction", op: "eq", value: "inbound" },
        { column: "status", op: "neq", value: "missed" },
        { column: "started_at", op: "gte", value: expect.any(String) }
      ]
    });
  });

  it("sentiment drill-down filters by sentiment on the box", async () => {
    dispatchMovedRows({ voice_call_transcripts: [BOX_CALL] });
    const detail = await getSentimentCallsDetail(BIZ, "neutral", {
      client: analyticsCentralDb(),
      now: NOW
    });
    expect(detail.calls[0]).toMatchObject({ id: "t1", summary: "Neutral chat." });
    expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
      table: "voice_call_transcripts",
      filters: expect.arrayContaining([
        { column: "direction", op: "eq", value: "inbound" },
        { column: "sentiment", op: "eq", value: "neutral" }
      ])
    });
  });

  it("hour drill-down scans box transcripts and filters by local hour", async () => {
    dispatchMovedRows({
      voice_call_transcripts: [
        { ...BOX_CALL, id: "match", started_at: "2026-07-04T19:30:00Z" },
        { ...BOX_CALL, id: "miss", started_at: "2026-07-04T20:30:00Z" }
      ]
    });
    const detail = await getHourCallsDetail(BIZ, 12, {
      client: analyticsCentralDb({ system_logs: { data: [], error: null } }),
      now: NOW,
      timeZone: "America/Phoenix"
    });
    expect(detail.calls.map((c) => c.id)).toEqual(["match"]);
    expect(detail.turnedAway).toBe(0);
  });
});

describe("sms-history vps reads (outbound log only)", () => {
  it("listConversationsForBusiness folds box outbound sends into the index", async () => {
    const db = centralDb({ sms_inbound_jobs: [] });
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      {
        id: "o9",
        business_id: BIZ,
        to_e164: "+1777",
        from_e164: null,
        body: "intro text",
        source: "ai_flow",
        run_id: null,
        flow_id: null,
        telnyx_message_id: null,
        channel: "sms",
        created_at: "2026-07-06T00:00:00Z"
      }
    ] as never);
    const convos = await listConversationsForBusiness(BIZ, {}, db);
    expect(convos).toEqual([
      {
        customerE164: "+1777",
        lastMessageAt: "2026-07-06T00:00:00Z",
        lastMessage: "intro text",
        lastStatus: "done",
        messageCount: 1
      }
    ]);
    expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
      table: "sms_outbound_log",
      filters: [{ column: "business_id", op: "eq", value: BIZ }]
    });
  });

  it("listMessagesForCustomer reads inbound jobs centrally and outbound from the box", async () => {
    const db = centralDb({ sms_inbound_jobs: [] });
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      {
        id: "o1",
        business_id: BIZ,
        to_e164: "+1555",
        from_e164: null,
        body: "flow says hi",
        source: "ai_flow",
        run_id: null,
        flow_id: null,
        telnyx_message_id: null,
        channel: "sms",
        created_at: "2026-07-05T00:00:00Z"
      }
    ] as never);
    const messages = await listMessagesForCustomer(BIZ, "+1555", {}, db);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "outbound", content: "flow says hi" });
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "sms_outbound_log",
      columns: expect.arrayContaining(["to_e164", "body", "source"]),
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "to_e164", op: "eq", value: "+1555" }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 50
    });
  });
});
