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

// The roster behind the team-performance card; `employees` is a CENTRAL
// table, stubbed here so each case can name its own teammate.
vi.mock("@/lib/db/employees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/employees")>();
  return { ...actual, listTeamMembers: vi.fn(async () => []) };
});

import {
  countMovedRows,
  isVpsReadMode,
  readMovedRows,
  ResidencyReadError
} from "@/lib/residency/read";
import {
  contactExistsForBusiness,
  listContactsByEmail,
  listContactsByLeadPhone,
  listTaggedContacts
} from "@/lib/contacts/lookup";
import {
  FLOW_COLS_FOR_TEST,
  FLOW_COLUMNS,
  enqueueAiFlowRun,
  getAiFlow,
  listAiFlowDefinitions,
  listAiFlows
} from "@/lib/ai-flows/db";
import {
  SCHEDULED_SMS_HISTORY_LIMIT,
  SCHEDULED_SMS_PENDING_LIMIT,
  listScheduledSmsForDashboard
} from "@/lib/db/scheduled-sms";
import { listEmailLog, listEmailLogForAddress, getEmailBody, getEmailLogRow } from "@/lib/db/email-log";
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
import { getEmployeePerformance } from "@/lib/analytics/employee-performance";
import { getLeadSourceOverview } from "@/lib/analytics/lead-sources";
import { getEngagementOverview } from "@/lib/analytics/engagement";
import { getRetentionOverview } from "@/lib/analytics/retention";
import { getMonthlySummary } from "@/lib/analytics/monthly-summary";
import { getQuoteFunnel } from "@/lib/analytics/quote-funnel";
import { getRenewalPipeline } from "@/lib/analytics/renewal-pipeline";
import { DEALS_CONTACT_CHUNK, getDealsOverview } from "@/lib/analytics/deals";
import { listTeamMembers } from "@/lib/db/employees";

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
    expect(await listEmailLog(BIZ, { limit: 10 }, centralDb({}))).toEqual([
      {
        id: "e1",
        created_at: "2026-07-07T00:00:00Z",
        is_read: false,
        archived_at: null,
        folder: null,
        labels: [],
        importance: null,
        // A box on an image older than the receipts migration returns rows
        // without these columns; undefined would read as "not null" to a
        // truthiness check, so they are pinned here.
        delivery_status: null,
        delivery_error_code: null,
        delivery_error_message: null,
        delivery_updated_at: null
      }
    ]);
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "email_log",
      // importance rides the box projection too. EMAIL_LOG_COLUMNS is a hand
      // maintained mirror of EMAIL_LOG_SELECT, so a column added to one and
      // not the other silently blanks the field for residency tenants only.
      columns: expect.arrayContaining([
        "id",
        "body_preview",
        "created_at",
        "is_read",
        "archived_at",
        "folder",
        "labels",
        "importance"
      ]),
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 10
    });
  });

  it("asks the box to drop alert mail, negated rather than enumerated", async () => {
    // The box compiles a negated `in` to NOT (source IN (...)), matching what
    // PostgREST does centrally. Expressing this as "every source EXCEPT" would
    // silently hide any source added later.
    await listEmailLog(BIZ, { excludeSources: ["notification"] }, centralDb({}));
    expect(readMovedRows).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        filters: expect.arrayContaining([
          { column: "source", op: "in", value: ["notification"], negate: true }
        ])
      })
    );
  });

  it("listEmailLogForAddress asks the box ONE OR query, and still exact-matches in JS", async () => {
    const addr = "joe_smith@x.com";
    const b = { id: "e2", created_at: "2026-07-03T00:00:00Z", from_email: null, to_email: "JOE_SMITH@X.COM" };
    const c = { id: "e3", created_at: "2026-07-02T00:00:00Z", from_email: addr, to_email: null };
    // A wildcard near-miss (joeXsmith) that a broken ILIKE-escape would let
    // through; the JS exact-match post-filter must still drop it.
    const nearMiss = {
      id: "e9",
      created_at: "2026-07-04T00:00:00Z",
      from_email: "joeXsmith@x.com",
      to_email: null
    };
    // The box now orders and limits, so the mock returns what a single
    // ordered query would: newest first, one row per id.
    vi.mocked(readMovedRows).mockResolvedValueOnce([nearMiss, b, c] as never);
    const rows = await listEmailLogForAddress(BIZ, "joe_smith@x.com", { limit: 3 }, centralDb({}));
    expect(rows.map((r) => r.id)).toEqual(["e2", "e3"]);

    // One round-trip, not two: the OR group replaced the merge-in-JS.
    const calls = vi.mocked(readMovedRows).mock.calls;
    expect(calls).toHaveLength(1);
    // LIKE metachars in the local-part are still escaped for the box's ILIKE.
    expect(calls[0][1]).toMatchObject({
      filters: expect.arrayContaining([
        {
          or: [
            [{ column: "from_email", op: "ilike", value: "joe\\_smith@x.com" }],
            [{ column: "to_email", op: "ilike", value: "joe\\_smith@x.com" }]
          ]
        }
      ])
    });
  });

  it("getEmailBody returns the box row or null, defaulting attachments", async () => {
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      { body_preview: "p", body_full: "f", body_html: "<p>f</p>", attachments: null }
    ] as never);
    expect(await getEmailBody(BIZ, "e1", centralDb({}))).toEqual({
      body_preview: "p",
      body_full: "f",
      body_html: "<p>f</p>",
      attachments: []
    });
    const att = [{ filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1, storage_path: "p" }];
    vi.mocked(readMovedRows).mockResolvedValueOnce([
      { body_preview: null, body_full: null, attachments: att }
    ] as never);
    const e2 = await getEmailBody(BIZ, "e2", centralDb({}));
    expect(e2?.attachments).toEqual(att);
    // Legacy box rows without the body_html column read back as null.
    expect(e2?.body_html).toBeNull();
    vi.mocked(readMovedRows).mockResolvedValueOnce([] as never);
    expect(await getEmailBody(BIZ, "e404", centralDb({}))).toBeNull();
  });
});

describe("email-log single-row vps reads", () => {
  it("getEmailLogRow routes to the box, scoped and limited to one", async () => {
    vi.mocked(readMovedRows).mockResolvedValue([{ id: "e9", labels: null }] as never);
    const row = await getEmailLogRow(BIZ, "e9", centralDb({}));
    expect(row).toMatchObject({ id: "e9", is_read: false, labels: [] });
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "email_log",
      columns: expect.any(Array),
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null },
        { column: "id", op: "eq", value: "e9" }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 1
    });
  });

  it("getEmailLogRow returns null when the box has no such row", async () => {
    vi.mocked(readMovedRows).mockResolvedValueOnce([] as never);
    expect(await getEmailLogRow(BIZ, "gone", centralDb({}))).toBeNull();
  });
});

describe("notifications vps reads", () => {
  it("getNotifications routes with the unreadOnly filter when asked", async () => {
    await getNotifications(BIZ, { limit: 5, unreadOnly: true }, centralDb({}));
    expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
      table: "notifications",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null },
        { column: "read_at", op: "is", value: null }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 5
    });
    await getNotifications(BIZ, 7, centralDb({}));
    expect(vi.mocked(readMovedRows).mock.calls[1][1]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null }
      ],
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
        { column: "read_at", op: "is", value: null },
        { column: "deleted_at", op: "is", value: null }
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
    for (const m of ["select", "eq", "is", "in"]) chain[m] = vi.fn(() => chain);
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
        { column: "caller_e164", op: "in", value: ["+1555", "+1556"] },
        { column: "deleted_at", op: "is", value: null }
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
   * (thenable head count or list), and `sms_inbound_jobs` (thenable list),
   * all control-plane/engine tables that never move to the box.
   */
  function analyticsCentralDb(resultsByTable: Record<string, unknown> = {}) {
    const builder = (table: string) => {
      const chain: Record<string, unknown> = {};
      // `or` / `in` are here so a read that WRONGLY goes central still
      // resolves to an empty result set instead of crashing on a missing
      // method: that is what makes the employee-performance cases below
      // fail with the false accusation they are guarding against.
      for (const m of [
        "select",
        "eq",
        "neq",
        "is",
        "not",
        "gte",
        "lt",
        "lte",
        "order",
        "limit",
        "or",
        "in"
      ]) {
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

  /** The box request for one moved table, or undefined if never read. */
  function movedRequest(table: string) {
    return vi
      .mocked(readMovedRows)
      .mock.calls.find((c) => (c[1] as { table: string }).table === table)?.[1];
  }

  /** Every table name the CENTRAL client was asked for. */
  function centralTables(db: unknown): string[] {
    return (db as { from: { mock: { calls: unknown[][] } } }).from.mock.calls.map(
      (c) => c[0] as string
    );
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
        { column: "deleted_at", op: "is", value: null },
        { column: "started_at", op: "gte", value: "2026-07-03T00:00:00.000Z" },
        { column: "started_at", op: "lt", value: "2026-07-04T00:00:00.000Z" }
      ],
      order: [{ column: "started_at", ascending: false }],
      // Same scan cap as the 30-day series so header totals match the chart.
      limit: 2000
    });
    expect(calls[1][1]).toMatchObject({
      table: "sms_outbound_log",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null },
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
        { column: "deleted_at", op: "is", value: null },
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
        { column: "deleted_at", op: "is", value: null },
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

  /**
   * The team card's "no touch in 48h" column accuses a NAMED teammate, so
   * every table it consults has to come from the same place the claim's
   * transcripts do. contacts, sms_outbound_log and email_log are all moved
   * tables: reading them centrally for a vps tenant returned nothing, and an
   * empty touch scan reads as "nobody followed up".
   */
  describe("employee performance vps reads", () => {
    const DAVE = "+16025550001";
    const LEAD = "+16025559999";
    /** now - 30 days, the window every touch scan is bounded by. */
    const CUTOFF = "2026-06-04T12:00:00.000Z";
    /** Claimed at run start, so the 48h grace closed on 2026-07-03. */
    const CLAIM_MS = Date.parse("2026-07-01T00:00:00Z");

    function roster() {
      vi.mocked(listTeamMembers).mockResolvedValue([
        {
          id: "m-dave",
          business_id: BIZ,
          name: "Dave",
          phone_e164: DAVE,
          email: null,
          active: true,
          last_offered_at: null,
          weekly_schedule: null,
          preferred_windows: null,
          created_at: "2026-01-01T00:00:00Z"
        }
      ] as never);
    }

    /** One elapsed-grace claim by Dave on `leadPhone`. */
    function claimRun(leadPhone: string) {
      return {
        context: {
          routing: { offered_log: [DAVE], claimed_by: DAVE, claimed_at_ms: CLAIM_MS },
          vars: { lead_phone: leadPhone }
        },
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:05:00Z"
      };
    }

    function runsDb(...runs: unknown[]) {
      return analyticsCentralDb({ ai_flow_runs: { data: runs, error: null } });
    }

    beforeEach(() => {
      roster();
    });

    it("sees a box-side text, so the claim is not counted as untouched", async () => {
      dispatchMovedRows({
        contacts: [{ customer_e164: LEAD, alias_e164s: [], email: "lead@example.com" }],
        sms_outbound_log: [{ to_e164: LEAD, created_at: "2026-07-01T01:00:00Z" }]
      });
      const rows = await getEmployeePerformance(BIZ, { client: runsDb(claimRun(LEAD)), now: NOW });
      expect(rows[0]).toMatchObject({ claimed: 1, claimedNoTouch48h: 0 });

      // Contacts: primary-number match only, the box filter grammar has no
      // array-overlap op for the central alias leg.
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: ["customer_e164", "alias_e164s", "email"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "customer_e164", op: "in", value: [LEAD] }
        ],
        limit: 200
      });
      expect(movedRequest("sms_outbound_log")).toEqual({
        table: "sms_outbound_log",
        columns: ["to_e164", "created_at"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "to_e164", op: "in", value: [LEAD] },
          { column: "created_at", op: "gte", value: CUTOFF }
        ],
        order: [{ column: "created_at", ascending: false }],
        limit: 2000
      });
      expect(movedRequest("email_log")).toEqual({
        table: "email_log",
        columns: ["to_email", "created_at"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "direction", op: "eq", value: "outbound" },
          { column: "created_at", op: "gte", value: CUTOFF }
        ],
        order: [{ column: "created_at", ascending: false }],
        limit: 2000
      });
    });

    it("sees a box-side email touch, matched case-insensitively", async () => {
      dispatchMovedRows({
        contacts: [{ customer_e164: LEAD, alias_e164s: null, email: "Lead@Example.com" }],
        email_log: [{ to_email: "LEAD@example.com  ", created_at: "2026-07-02T09:00:00Z" }]
      });
      const rows = await getEmployeePerformance(BIZ, { client: runsDb(claimRun(LEAD)), now: NOW });
      expect(rows[0]).toMatchObject({ claimedNoTouch48h: 0 });
    });

    it("sees a box-side forwarded call as a touch", async () => {
      dispatchMovedRows({
        voice_call_transcripts: [
          { forwarded_to_e164: DAVE, caller_e164: LEAD, started_at: "2026-07-01T02:00:00Z" }
        ],
        contacts: [{ customer_e164: LEAD, alias_e164s: [], email: null }]
      });
      const rows = await getEmployeePerformance(BIZ, { client: runsDb(claimRun(LEAD)), now: NOW });
      expect(rows[0]).toMatchObject({ forwardedCalls: 1, claimedNoTouch48h: 0 });
      // No contact email, so the email scan is skipped entirely.
      expect(movedRequest("email_log")).toBeUndefined();
    });

    it("still counts a real no-touch claim on the box path", async () => {
      dispatchMovedRows({
        contacts: [{ customer_e164: LEAD, alias_e164s: [], email: "lead@example.com" }],
        sms_outbound_log: [
          // Same lead, but three days after the grace window closed.
          { to_e164: LEAD, created_at: "2026-07-04T09:00:00Z" }
        ]
      });
      const rows = await getEmployeePerformance(BIZ, { client: runsDb(claimRun(LEAD)), now: NOW });
      expect(rows[0]).toMatchObject({ claimedNoTouch48h: 1 });
    });

    it("leaves a lead the box cannot resolve to a contact unjudged", async () => {
      // An unmatched phone on the box path could be a merged-away alias
      // whose surviving contact holds the email that WAS written, so the
      // claim is skipped rather than counted. With nothing judgeable left,
      // the touch scans never run (an empty `in` list is a box error).
      dispatchMovedRows({ contacts: [] });
      const rows = await getEmployeePerformance(BIZ, { client: runsDb(claimRun(LEAD)), now: NOW });
      expect(rows[0]).toMatchObject({ claimed: 1, claimedNoTouch48h: 0 });
      expect(movedRequest("sms_outbound_log")).toBeUndefined();
      expect(movedRequest("email_log")).toBeUndefined();
    });

    it("judges the resolvable lead and skips the unresolvable one", async () => {
      const OTHER = "+16025558888";
      dispatchMovedRows({
        contacts: [{ customer_e164: LEAD, alias_e164s: [], email: null }]
      });
      const rows = await getEmployeePerformance(BIZ, {
        client: runsDb(claimRun(LEAD), claimRun(OTHER)),
        now: NOW
      });
      // Two claims, only the resolved one is judged, and it is untouched.
      expect(rows[0]).toMatchObject({ claimed: 2, claimedNoTouch48h: 1 });
      expect(movedRequest("sms_outbound_log")).toMatchObject({
        filters: expect.arrayContaining([{ column: "to_e164", op: "in", value: [LEAD] }])
      });
    });
  });

  /**
   * The contact-backed cards. `contacts` is a moved table, so for a vps
   * tenant every one of these read an empty central table and rendered
   * zeros: no leads this month, nobody to win back, no quotes in flight, no
   * names on the renewal book, every won deal filed under "No source". Each
   * case pins the box request AND asserts central was never asked for
   * `contacts`. The central paths keep their own suites
   * (tests/analytics-*.test.ts), which now pin central mode explicitly.
   */
  describe("contact-backed analytics vps reads", () => {
    /** analyticsWindowStart(NOW, 30), the boundary every windowed card uses. */
    const WINDOW_START = "2026-06-05T00:00:00.000Z";

    it("lead sources folds the box's new contacts", async () => {
      dispatchMovedRows({
        contacts: [
          {
            lead_source: "Clever",
            last_channel: "sms",
            tags: ["VIP"],
            owner_employee_id: "m-dave",
            total_interaction_count: 3
          },
          {
            lead_source: null,
            last_channel: "voice",
            tags: [],
            owner_employee_id: null,
            total_interaction_count: 0
          }
        ]
      });
      const db = analyticsCentralDb();
      const overview = await getLeadSourceOverview(BIZ, { client: db, now: NOW });

      expect(overview.totalNewContacts).toBe(2);
      expect(overview.sources).toEqual([
        { label: "Clever", newContacts: 1, engaged: 1, claimed: 1 },
        { label: "voice", newContacts: 1, engaged: 0, claimed: 0 }
      ]);
      expect(overview.tags).toEqual([{ label: "VIP", newContacts: 1, engaged: 1, claimed: 1 }]);
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: [
          "lead_source",
          "last_channel",
          "tags",
          "owner_employee_id",
          "total_interaction_count"
        ],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "type", op: "eq", value: "customer" },
          { column: "created_at", op: "gte", value: WINDOW_START }
        ],
        order: [{ column: "created_at", ascending: false }],
        limit: 5000
      });
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("engagement segments and the quiet shortlist come from the box directory", async () => {
      dispatchMovedRows({
        contacts: [
          {
            customer_e164: "+16025551111",
            display_name: "Quiet Quinn",
            created_at: "2026-01-01T00:00:00Z",
            last_interaction_at: "2026-02-01T00:00:00Z",
            total_interaction_count: 9
          },
          {
            customer_e164: "+16025552222",
            display_name: "Active Amy",
            created_at: "2026-01-01T00:00:00Z",
            last_interaction_at: "2026-07-01T00:00:00Z",
            total_interaction_count: 4
          }
        ]
      });
      const db = analyticsCentralDb();
      const overview = await getEngagementOverview(BIZ, { client: db, now: NOW });

      expect(overview.counts).toEqual({ new: 0, active: 1, cooling: 0, quiet: 1 });
      expect(overview.total).toBe(2);
      expect(overview.quietCustomers).toEqual([
        {
          e164: "+16025551111",
          name: "Quiet Quinn",
          lastInteractionAt: "2026-02-01T00:00:00Z",
          totalInteractions: 9
        }
      ]);
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: [
          "customer_e164",
          "display_name",
          "created_at",
          "last_interaction_at",
          "total_interaction_count"
        ],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "type", op: "eq", value: "customer" }
        ],
        limit: 5000
      });
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("retention bands the box's contacts", async () => {
      dispatchMovedRows({
        contacts: [
          // Older than the window, active inside it: retained AND returning.
          {
            created_at: "2026-01-01T00:00:00Z",
            last_interaction_at: "2026-07-01T00:00:00Z",
            total_interaction_count: 5
          },
          // 45 days silent: the at-risk middle.
          {
            created_at: "2026-01-01T00:00:00Z",
            last_interaction_at: "2026-05-20T00:00:00Z",
            total_interaction_count: 2
          },
          // 90+ days silent: lapsed.
          {
            created_at: "2026-01-01T00:00:00Z",
            last_interaction_at: "2026-01-02T00:00:00Z",
            total_interaction_count: 1
          },
          // Created in the window, never interacted: new, not engagedEver.
          {
            created_at: "2026-07-01T00:00:00Z",
            last_interaction_at: null,
            total_interaction_count: 0
          }
        ]
      });
      const db = analyticsCentralDb();
      const overview = await getRetentionOverview(BIZ, { client: db, now: NOW });

      expect(overview).toEqual({
        engagedEver: 3,
        retained: 1,
        atRisk: 1,
        lapsed: 1,
        retentionRate: 0.33,
        returning: 1,
        newInWindow: 1,
        clipped: false
      });
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: ["created_at", "last_interaction_at", "total_interaction_count"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "type", op: "eq", value: "customer" }
        ],
        limit: 5000
      });
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("the monthly summary counts new contacts on the box, one mode lookup for both months", async () => {
      // Dispatched on the month boundary rather than on call order, so the
      // case still means something if the two months stop being awaited
      // together.
      vi.mocked(countMovedRows).mockImplementation(async (_biz, request) => {
        const from = (request as { filters?: Array<{ column: string; op: string; value: unknown }> })
          .filters?.find((f) => f.column === "created_at" && f.op === "gte")?.value;
        return from === "2026-07-01T00:00:00.000Z" ? 7 : 4;
      });
      const db = analyticsCentralDb({
        analytics_daily_snapshots: {
          data: [{ calls: 3, sms_sent: 11, voice_minutes: 6, missed_calls: 1 }],
          error: null
        }
      });
      const summary = await getMonthlySummary(BIZ, { client: db, now: NOW });

      expect(summary.current).toEqual({
        month: "2026-07",
        calls: 3,
        texts: 11,
        voiceMinutes: 6,
        missedCalls: 1,
        newContacts: 7,
        coveredDays: 1
      });
      expect(summary.previous).toMatchObject({ month: "2026-06", newContacts: 4 });
      // Head count, never a row fetch.
      expect(readMovedRows).not.toHaveBeenCalled();
      expect(vi.mocked(countMovedRows).mock.calls[0][1]).toEqual({
        table: "contacts",
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "type", op: "eq", value: "customer" },
          { column: "created_at", op: "gte", value: "2026-07-01T00:00:00.000Z" },
          { column: "created_at", op: "lt", value: "2026-08-01T00:00:00.000Z" }
        ]
      });
      // Resolved once for the whole render, not once per month.
      expect(isVpsReadMode).toHaveBeenCalledTimes(1);
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("the quote funnel stages the box's tags", async () => {
      dispatchMovedRows({
        contacts: [
          // Furthest stage wins: this contact is a win, not two entries.
          { tags: ["quote-requested", "Quote-Won"] },
          { tags: ["quote-lost"] },
          { tags: null }
        ]
      });
      const db = analyticsCentralDb();
      const funnel = await getQuoteFunnel(BIZ, { client: db });

      expect(funnel.counts).toEqual({
        "quote-requested": 0,
        "quote-received": 0,
        "quote-presented": 0,
        "quote-won": 1,
        "quote-lost": 1
      });
      expect(funnel.totalTracked).toBe(2);
      expect(funnel.conversionRate).toBe(0.5);
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: ["tags"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "type", op: "eq", value: "customer" }
        ],
        limit: 5000
      });
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("the renewal pipeline names its rows from the box, documents stay central", async () => {
      const db = analyticsCentralDb({
        business_documents: {
          data: [
            {
              id: "d1",
              title: "Auto policy",
              category: "insurance",
              renewal_date: "2026-07-20T00:00:00Z",
              contact_id: "c1",
              assigned_employee_id: "m-dave"
            }
          ],
          error: null
        }
      });
      dispatchMovedRows({
        contacts: [{ id: "c1", display_name: "  Rita  ", customer_e164: "+16025553333" }]
      });
      const pipeline = await getRenewalPipeline(BIZ, { client: db, now: NOW });

      expect(pipeline.rows).toEqual([
        {
          documentId: "d1",
          title: "Auto policy",
          category: "insurance",
          renewalDate: "2026-07-20",
          daysUntil: 16,
          bucket: "next30",
          contactName: "Rita",
          contactE164: "+16025553333",
          assignedEmployee: null
        }
      ]);
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: ["id", "display_name", "customer_e164"],
        // Same single filter as central: the ids already come from this
        // business's documents, and a box holds one tenant.
        filters: [{ column: "id", op: "in", value: ["c1"] }],
        limit: 500
      });
      expect(centralTables(db)).toContain("business_documents");
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("won deals join the box's lead_source and owner", async () => {
      vi.mocked(listTeamMembers).mockResolvedValue([
        { id: "m-dave", name: "Dave" }
      ] as never);
      // All three `deals` reads share one scripted result (the stub keys by
      // table): 2 created, one won deal worth $50, one open deal worth $50.
      const db = analyticsCentralDb({
        deals: { data: [{ contact_id: "c1", value_cents: 5000 }], count: 2, error: null }
      });
      dispatchMovedRows({
        contacts: [{ id: "c1", lead_source: "Clever", owner_employee_id: "m-dave" }]
      });
      const overview = await getDealsOverview(BIZ, { client: db, now: NOW });

      expect(overview).toMatchObject({
        createdCount: 2,
        wonCount: 1,
        wonValueCents: 5000,
        bySource: [{ label: "Clever", wonCount: 1, wonValueCents: 5000 }],
        byOwner: [{ employeeId: "m-dave", name: "Dave", wonCount: 1, wonValueCents: 5000 }]
      });
      expect(movedRequest("contacts")).toEqual({
        table: "contacts",
        columns: ["id", "lead_source", "owner_employee_id"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "id", op: "in", value: ["c1"] }
        ],
        limit: 150
      });
      expect(centralTables(db)).not.toContain("contacts");
    });

    it("deals chunk the box lookup and resolve the mode once for the whole loop", async () => {
      const wonDeals = Array.from({ length: DEALS_CONTACT_CHUNK + 1 }, (_, i) => ({
        contact_id: `c${i}`,
        value_cents: 100
      }));
      const db = analyticsCentralDb({
        deals: { data: wonDeals, count: wonDeals.length, error: null }
      });
      dispatchMovedRows({ contacts: [] });
      await getDealsOverview(BIZ, { client: db, now: NOW });

      const contactCalls = vi
        .mocked(readMovedRows)
        .mock.calls.filter((c) => (c[1] as { table: string }).table === "contacts");
      expect(contactCalls).toHaveLength(2);
      expect(
        (contactCalls[0][1] as { filters: Array<{ value: string[] }> }).filters[1].value
      ).toHaveLength(DEALS_CONTACT_CHUNK);
      expect(
        (contactCalls[1][1] as { filters: Array<{ value: string[] }> }).filters[1].value
      ).toEqual([`c${DEALS_CONTACT_CHUNK}`]);
      expect(isVpsReadMode).toHaveBeenCalledTimes(1);
    });
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
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "deleted_at", op: "is", value: null }
      ]
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
        { column: "to_e164", op: "eq", value: "+1555" },
        { column: "deleted_at", op: "is", value: null }
      ],
      order: [{ column: "created_at", ascending: false }],
      limit: 50
    });
  });
});

/**
 * The dashboard API routes' own `contacts` / `ai_flows` / `scheduled_sms`
 * reads. `contacts` is a moved table, so on a vps tenant the Tasks board and
 * the leads Data grid read an empty central table and rendered an empty
 * board with no error at all. Each case pins the box request AND asserts
 * central was never asked for the moved table.
 */
describe("dashboard route vps reads", () => {
  const PHONE = "+16025550123";
  const OTHER = "+16025550999";

  type CentralResult = { data: unknown; error: { message: string } | null };

  /**
   * A central client whose every chain link is recorded, so a read that
   * WRONGLY stayed central is visible. The terminal await (or `maybeSingle`)
   * resolves to the canned result; pass an array to serve successive
   * `from()` calls in order (the scheduled-SMS queue issues two).
   */
  function trackedDb(result: CentralResult | CentralResult[]) {
    const chains: Array<{ table: string; calls: Array<[string, unknown[]]> }> = [];
    const from = vi.fn((table: string) => {
      const record: { table: string; calls: Array<[string, unknown[]]> } = { table, calls: [] };
      const served = Array.isArray(result)
        ? result[Math.min(chains.length, result.length - 1)]
        : result;
      chains.push(record);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "is", "in", "or", "order", "limit"]) {
        chain[m] = vi.fn((...args: unknown[]) => {
          record.calls.push([m, args]);
          return chain;
        });
      }
      chain.maybeSingle = vi.fn(async () => served);
      (chain as { then: unknown }).then = (
        onF: (v: unknown) => unknown,
        onR: (e: unknown) => unknown
      ) => Promise.resolve(served).then(onF, onR);
      return chain;
    });
    return { db: { from } as never, chains };
  }

  /** Every argument one central chain passed to `method`. */
  function argsFor(
    chains: Array<{ table: string; calls: Array<[string, unknown[]]> }>,
    table: string,
    method: string
  ): unknown[][] {
    return chains
      .filter((c) => c.table === table)
      .flatMap((c) => c.calls.filter(([m]) => m === method).map(([, args]) => args));
  }

  describe("contacts lookups", () => {
    const ctx = (vpsReadMode: boolean, db: never) => ({
      businessId: BIZ,
      db,
      vpsReadMode,
      label: "tasks"
    });

    it("matches lead phones on the box by primary number OR alias, like central", async () => {
      // This used to be a documented degradation: the box grammar had no OR
      // and no array-overlap, so a lead keyed on a merged-away alias resolved
      // to no contact at all. `or` + `overlaps` retired the trade, and this
      // asserts the box now sends exactly what central's
      // `customer_e164.in.(...),alias_e164s.ov.{...}` means.
      vi.mocked(readMovedRows).mockResolvedValue([
        { customer_e164: OTHER, alias_e164s: [PHONE] }
      ] as never);
      const { db, chains } = trackedDb({ data: [], error: null });
      const rows = await listContactsByLeadPhone<{ customer_e164: string }>(ctx(true, db), {
        columns: ["customer_e164", "alias_e164s"],
        phones: [PHONE, OTHER]
      });
      // The merged-away alias resolves to its surviving primary row.
      expect(rows).toEqual([{ customer_e164: OTHER, alias_e164s: [PHONE] }]);
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "contacts",
        columns: ["customer_e164", "alias_e164s"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          {
            or: [
              [{ column: "customer_e164", op: "in", value: [PHONE, OTHER] }],
              [{ column: "alias_e164s", op: "overlaps", value: [PHONE, OTHER] }]
            ]
          }
        ]
      });
      expect(chains).toHaveLength(0);
    });

    it("keeps the alias-overlap leg on the central path", async () => {
      const { db, chains } = trackedDb({
        data: [{ customer_e164: PHONE, alias_e164s: [OTHER] }],
        error: null
      });
      const rows = await listContactsByLeadPhone<{ customer_e164: string }>(ctx(false, db), {
        columns: ["customer_e164", "alias_e164s"],
        phones: [PHONE, OTHER]
      });
      expect(rows).toEqual([{ customer_e164: PHONE, alias_e164s: [OTHER] }]);
      expect(readMovedRows).not.toHaveBeenCalled();
      expect(argsFor(chains, "contacts", "select")).toEqual([["customer_e164, alias_e164s"]]);
      expect(argsFor(chains, "contacts", "or")).toEqual([
        [`customer_e164.in.(${PHONE},${OTHER}),alias_e164s.ov.{${PHONE},${OTHER}}`]
      ]);
    });

    /**
     * The deliberate degradation. A lead keyed on a merged-away alias has no
     * box row of its own, so it comes back UNRESOLVED rather than folded
     * onto whichever contact a widened scan happened to return: the box
     * grammar has no OR and no array overlap, and PR #1547 made the same
     * trade for the same filter. Less complete, never mis-attributed.
     */
    it("leaves a merged-away alias unresolved on the box, never re-keyed", async () => {
      // The surviving contact holds OTHER as an alias, but the box can only
      // be asked about primaries, and OTHER is nobody's primary.
      vi.mocked(readMovedRows).mockResolvedValue([] as never);
      const { db } = trackedDb({ data: [], error: null });
      const rows = await listContactsByLeadPhone<{ customer_e164: string }>(ctx(true, db), {
        columns: ["customer_e164", "alias_e164s"],
        phones: [OTHER]
      });
      expect(rows).toEqual([]);
      // Central, the same lookup DOES resolve it, onto a different primary.
      const central = trackedDb({
        data: [{ customer_e164: PHONE, alias_e164s: [OTHER] }],
        error: null
      });
      expect(
        await listContactsByLeadPhone<{ customer_e164: string }>(ctx(false, central.db), {
          columns: ["customer_e164", "alias_e164s"],
          phones: [OTHER]
        })
      ).toEqual([{ customer_e164: PHONE, alias_e164s: [OTHER] }]);
    });

    it("never sends the box an empty `in` list", async () => {
      const { db, chains } = trackedDb({ data: [], error: null });
      expect(
        await listContactsByLeadPhone(ctx(true, db), { columns: ["customer_e164"], phones: [] })
      ).toEqual([]);
      expect(
        await listContactsByEmail(ctx(true, db), { columns: ["customer_e164"], emails: [] })
      ).toEqual([]);
      expect(readMovedRows).not.toHaveBeenCalled();
      expect(chains).toHaveLength(0);
    });

    it("matches emails on the box, and central keeps its escaped IN", async () => {
      vi.mocked(readMovedRows).mockResolvedValue([{ customer_e164: PHONE }] as never);
      const boxDb = trackedDb({ data: [], error: null });
      expect(
        await listContactsByEmail<{ customer_e164: string }>(ctx(true, boxDb.db), {
          columns: ["customer_e164", "email"],
          emails: ["lead@example.com"]
        })
      ).toEqual([{ customer_e164: PHONE }]);
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "contacts",
        columns: ["customer_e164", "email"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "email", op: "in", value: ["lead@example.com"] }
        ]
      });

      const central = trackedDb({ data: [{ customer_e164: OTHER }], error: null });
      expect(
        await listContactsByEmail<{ customer_e164: string }>(ctx(false, central.db), {
          columns: ["customer_e164", "email"],
          emails: ["lead@example.com"]
        })
      ).toEqual([{ customer_e164: OTHER }]);
      expect(argsFor(central.chains, "contacts", "in")).toEqual([
        ["email", ["lead@example.com"]]
      ]);
    });

    it("scans tagged contacts on the box with the empty-array comparison", async () => {
      vi.mocked(readMovedRows).mockResolvedValue([
        { customer_e164: PHONE, updated_at: "2026-07-01T00:00:00Z" }
      ] as never);
      const { db, chains } = trackedDb({ data: [], error: null });
      const rows = await listTaggedContacts<{ customer_e164: string; updated_at: string }>(
        ctx(true, db),
        { columns: ["customer_e164", "updated_at"], limit: 60 }
      );
      expect(rows).toHaveLength(1);
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "contacts",
        columns: ["customer_e164", "updated_at"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "tags", op: "neq", value: "{}" }
        ],
        order: [{ column: "updated_at", ascending: false }],
        limit: 60
      });
      expect(chains).toHaveLength(0);
    });

    it("narrows tagged contacts to one owner on the box", async () => {
      vi.mocked(readMovedRows).mockResolvedValue([] as never);
      const { db } = trackedDb({ data: [], error: null });
      await listTaggedContacts<{ customer_e164: string; updated_at: string }>(ctx(true, db), {
        columns: ["customer_e164", "updated_at"],
        limit: 200,
        owner: { employeeId: "m-dave", includeUnowned: false }
      });
      expect(readMovedRows).toHaveBeenCalledTimes(1);
      expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "tags", op: "neq", value: "{}" },
          { column: "owner_employee_id", op: "eq", value: "m-dave" }
        ]
      });
    });

    it("sends the one-person-roster OR to the box as a single query", async () => {
      // Was two capped reads merged and re-sorted in JS. That merge was
      // exact, but it cost a second tunnel round-trip and a sort the database
      // was already doing; the OR group replaced both.
      vi.mocked(readMovedRows).mockResolvedValue([
        { customer_e164: OTHER, updated_at: "2026-07-03T00:00:00Z" },
        { customer_e164: PHONE, updated_at: "2026-07-02T00:00:00Z" }
      ] as never);
      const { db } = trackedDb({ data: [], error: null });
      const rows = await listTaggedContacts<{ customer_e164: string; updated_at: string }>(
        ctx(true, db),
        {
          columns: ["customer_e164", "updated_at"],
          limit: 2,
          owner: { employeeId: "m-dave", includeUnowned: true }
        }
      );
      expect(rows.map((r) => r.customer_e164)).toEqual([OTHER, PHONE]);
      expect(readMovedRows).toHaveBeenCalledTimes(1);
      expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
        filters: expect.arrayContaining([
          {
            or: [
              [{ column: "owner_employee_id", op: "eq", value: "m-dave" }],
              [{ column: "owner_employee_id", op: "is", value: null }]
            ]
          }
        ]),
        limit: 2
      });
    });

    it("keeps the tagged-contact owner OR on the central path", async () => {
      const { db, chains } = trackedDb({
        data: [{ customer_e164: PHONE, updated_at: "2026-07-01T00:00:00Z" }],
        error: null
      });
      const rows = await listTaggedContacts<{ customer_e164: string; updated_at: string }>(
        ctx(false, db),
        {
          columns: ["customer_e164", "updated_at"],
          limit: 200,
          owner: { employeeId: "m-dave", includeUnowned: true }
        }
      );
      expect(rows).toHaveLength(1);
      expect(readMovedRows).not.toHaveBeenCalled();
      expect(argsFor(chains, "contacts", "neq")).toEqual([["tags", "{}"]]);
      expect(argsFor(chains, "contacts", "or")).toEqual([
        ["owner_employee_id.eq.m-dave,owner_employee_id.is.null"]
      ]);
      expect(argsFor(chains, "contacts", "limit")).toEqual([[200]]);
    });

    it("narrows to one owner centrally, and surfaces a central error", async () => {
      const ok = trackedDb({ data: null, error: null });
      expect(
        await listTaggedContacts<{ customer_e164: string; updated_at: string }>(ctx(false, ok.db), {
          columns: ["customer_e164", "updated_at"],
          limit: 200,
          owner: { employeeId: "m-dave", includeUnowned: false }
        })
      ).toEqual([]);
      expect(argsFor(ok.chains, "contacts", "eq")).toEqual([
        ["business_id", BIZ],
        ["owner_employee_id", "m-dave"]
      ]);

      // A central read that matched nothing is an empty list, never null.
      expect(
        await listContactsByLeadPhone(ctx(false, ok.db), {
          columns: ["customer_e164"],
          phones: [PHONE]
        })
      ).toEqual([]);
      expect(
        await listContactsByEmail(ctx(false, ok.db), {
          columns: ["customer_e164"],
          emails: ["a@b.com"]
        })
      ).toEqual([]);

      const broken = trackedDb({ data: null, error: { message: "boom" } });
      await expect(
        listTaggedContacts<{ customer_e164: string; updated_at: string }>(ctx(false, broken.db), {
          columns: ["customer_e164"],
          limit: 10
        })
      ).rejects.toThrow("tasks: tagged contacts: boom");
      await expect(
        listContactsByLeadPhone(ctx(false, broken.db), {
          columns: ["customer_e164"],
          phones: [PHONE]
        })
      ).rejects.toThrow("tasks: contacts by phone: boom");
      await expect(
        listContactsByEmail(ctx(false, broken.db), {
          columns: ["customer_e164"],
          emails: ["a@b.com"]
        })
      ).rejects.toThrow("tasks: contacts by email: boom");
    });

    it("checks a linked contact's existence against the box, failing loudly", async () => {
      vi.mocked(readMovedRows).mockResolvedValue([{ id: "c1" }] as never);
      const { db, chains } = trackedDb({ data: null, error: null });
      expect(
        await contactExistsForBusiness({ businessId: BIZ, db, vpsReadMode: true }, "c1")
      ).toEqual({ ok: true, exists: true });
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "contacts",
        columns: ["id"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "id", op: "eq", value: "c1" }
        ],
        limit: 1
      });
      expect(chains).toHaveLength(0);

      vi.mocked(readMovedRows).mockResolvedValue([] as never);
      expect(
        await contactExistsForBusiness({ businessId: BIZ, db, vpsReadMode: true }, "c1")
      ).toEqual({ ok: true, exists: false });

      // An unreachable box is NOT "contact not found": the caller must be
      // able to say the lookup broke.
      vi.mocked(readMovedRows).mockRejectedValue(new ResidencyReadError(BIZ, "box down"));
      expect(
        await contactExistsForBusiness({ businessId: BIZ, db, vpsReadMode: true }, "c1")
      ).toEqual({ ok: false, error: "box down" });
      vi.mocked(readMovedRows).mockRejectedValue("not an Error");
      expect(
        await contactExistsForBusiness({ businessId: BIZ, db, vpsReadMode: true }, "c1")
      ).toEqual({ ok: false, error: "not an Error" });
    });

    it("checks contact existence centrally when the tenant is not on a box", async () => {
      const found = trackedDb({ data: { id: "c1" }, error: null });
      expect(
        await contactExistsForBusiness(
          { businessId: BIZ, db: found.db, vpsReadMode: false },
          "c1"
        )
      ).toEqual({ ok: true, exists: true });
      expect(argsFor(found.chains, "contacts", "eq")).toEqual([
        ["business_id", BIZ],
        ["id", "c1"]
      ]);
      expect(readMovedRows).not.toHaveBeenCalled();

      const missing = trackedDb({ data: null, error: null });
      expect(
        await contactExistsForBusiness(
          { businessId: BIZ, db: missing.db, vpsReadMode: false },
          "c1"
        )
      ).toEqual({ ok: true, exists: false });

      const broken = trackedDb({ data: null, error: { message: "central down" } });
      expect(
        await contactExistsForBusiness(
          { businessId: BIZ, db: broken.db, vpsReadMode: false },
          "c1"
        )
      ).toEqual({ ok: false, error: "central down" });
    });
  });

  describe("ai_flows definitions", () => {
    it("reads the Task Center's flow definitions from the box, tenant-scoped", async () => {
      vi.mocked(readMovedRows).mockResolvedValue([
        { id: "f1", name: "Intake", definition: { steps: [{ type: "message" }] } }
      ] as never);
      const { db, chains } = trackedDb({ data: [], error: null });
      const rows = await listAiFlowDefinitions(BIZ, ["f1"], { client: db, vpsReadMode: true });
      expect(rows[0]).toMatchObject({ id: "f1", name: "Intake" });
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "ai_flows",
        columns: ["id", "name", "definition"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "id", op: "in", value: ["f1"] }
        ]
      });
      expect(chains).toHaveLength(0);
    });

    it("reads them centrally otherwise, by id, and surfaces a central error", async () => {
      const ok = trackedDb({ data: [{ id: "f1", name: "Intake", definition: null }], error: null });
      expect(
        await listAiFlowDefinitions(BIZ, ["f1"], { client: ok.db, vpsReadMode: false })
      ).toEqual([{ id: "f1", name: "Intake", definition: null }]);
      expect(argsFor(ok.chains, "ai_flows", "in")).toEqual([["id", ["f1"]]]);
      expect(readMovedRows).not.toHaveBeenCalled();

      const empty = trackedDb({ data: null, error: null });
      expect(
        await listAiFlowDefinitions(BIZ, ["f1"], { client: empty.db, vpsReadMode: false })
      ).toEqual([]);

      const broken = trackedDb({ data: null, error: { message: "nope" } });
      await expect(
        listAiFlowDefinitions(BIZ, ["f1"], { client: broken.db, vpsReadMode: false })
      ).rejects.toThrow("listAiFlowDefinitions: nope");
    });

    it("skips both paths when no run named a flow", async () => {
      const { db, chains } = trackedDb({ data: [], error: null });
      expect(await listAiFlowDefinitions(BIZ, [], { client: db, vpsReadMode: true })).toEqual([]);
      expect(readMovedRows).not.toHaveBeenCalled();
      expect(chains).toHaveLength(0);
    });
  });

  describe("scheduled_sms queue", () => {
    it("reads pending and history from the box in two ordered calls", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockImplementation(async (_biz, request) => {
        const pending = (request as { filters: Array<{ op: string }> }).filters.some(
          (f) => f.op === "eq" && "value" in f && f.value === "pending"
        );
        return (pending ? [{ id: "s-next" }] : [{ id: "s-sent" }]) as never;
      });
      const { db, chains } = trackedDb({ data: [], error: null });
      const rows = await listScheduledSmsForDashboard(BIZ, db);
      expect(rows.map((r) => r.id)).toEqual(["s-next", "s-sent"]);
      expect(vi.mocked(readMovedRows).mock.calls[0][1]).toMatchObject({
        table: "scheduled_sms",
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "status", op: "eq", value: "pending" }
        ],
        order: [{ column: "send_at", ascending: true }],
        limit: SCHEDULED_SMS_PENDING_LIMIT
      });
      expect(vi.mocked(readMovedRows).mock.calls[1][1]).toMatchObject({
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "status", op: "neq", value: "pending" }
        ],
        order: [{ column: "send_at", ascending: false }],
        limit: SCHEDULED_SMS_HISTORY_LIMIT
      });
      expect(chains).toHaveLength(0);
      // created_by rides BOTH legs: it is what labels a queued text as the
      // texting coworker's rather than the owner's in the panel, and a vps
      // tenant must not lose that label by taking the box path.
      for (const call of vi.mocked(readMovedRows).mock.calls) {
        expect((call[1] as { columns: string[] }).columns).toContain("created_by");
      }
      // One mode lookup for both queries.
      expect(isVpsReadMode).toHaveBeenCalledTimes(1);
    });

    it("reads the queue centrally otherwise, and surfaces either error", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(false);
      const ok = trackedDb({ data: [{ id: "s1" }], error: null });
      expect((await listScheduledSmsForDashboard(BIZ, ok.db)).map((r) => r.id)).toEqual([
        "s1",
        "s1"
      ]);
      expect(argsFor(ok.chains, "scheduled_sms", "eq")).toEqual([
        ["business_id", BIZ],
        ["status", "pending"],
        ["business_id", BIZ]
      ]);
      expect(argsFor(ok.chains, "scheduled_sms", "neq")).toEqual([["status", "pending"]]);
      expect(readMovedRows).not.toHaveBeenCalled();

      const empty = trackedDb({ data: null, error: null });
      expect(await listScheduledSmsForDashboard(BIZ, empty.db)).toEqual([]);

      // Either leg failing is surfaced, not silently half-served.
      const brokenPending = trackedDb({ data: null, error: { message: "queue down" } });
      await expect(listScheduledSmsForDashboard(BIZ, brokenPending.db)).rejects.toThrow(
        "listScheduledSms: queue down"
      );
      const brokenHistory = trackedDb([
        { data: [], error: null },
        { data: null, error: { message: "history down" } }
      ]);
      await expect(listScheduledSmsForDashboard(BIZ, brokenHistory.db)).rejects.toThrow(
        "listScheduledSms: history down"
      );
    });
  });

  describe("ai_flows list, detail and enqueue gates", () => {
    it("pins the two column shapes together so the paths cannot drift", () => {
      // supabase-js needs FLOW_COLS to stay a literal to type the row, so the
      // array cannot be derived from it. This is the guard instead.
      expect(FLOW_COLUMNS.join(",")).toBe(FLOW_COLS_FOR_TEST);
    });

    it("lists a vps tenant's flows from their box, not centrally", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockResolvedValue([
        { id: "f1", business_id: BIZ, name: "Intake", enabled: true }
      ] as never);
      const { db, chains } = trackedDb({ data: [], error: null });
      const flows = await listAiFlows(BIZ, db);
      expect(flows[0]).toMatchObject({ id: "f1", name: "Intake" });
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "ai_flows",
        columns: [...FLOW_COLUMNS],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "deleted_at", op: "is", value: null }
        ],
        order: [{ column: "created_at", ascending: false }]
      });
      // The flows read moved; the runs read did NOT (ai_flow_runs is not a
      // residency-moved table), so exactly one central chain remains.
      expect(chains.map((c) => c.table)).toEqual(["ai_flow_runs"]);
    });

    it("an unreachable box fails the list instead of showing zero flows", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockRejectedValue(new Error("box down"));
      const { db } = trackedDb({ data: [], error: null });
      await expect(listAiFlows(BIZ, db)).rejects.toThrow("box down");
    });

    it("reads one flow from the box, and a miss is still a real miss", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockResolvedValue([{ id: "f1", name: "Intake" }] as never);
      const hit = trackedDb({ data: null, error: null });
      expect(await getAiFlow(BIZ, "f1", hit.db)).toMatchObject({ id: "f1" });
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "ai_flows",
        columns: [...FLOW_COLUMNS],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "id", op: "eq", value: "f1" },
          { column: "deleted_at", op: "is", value: null }
        ],
        limit: 1
      });
      expect(hit.chains).toHaveLength(0);

      vi.mocked(readMovedRows).mockResolvedValue([] as never);
      const miss = trackedDb({ data: null, error: null });
      expect(await getAiFlow(BIZ, "gone", miss.db)).toBeNull();
    });

    it("an unreachable box cannot masquerade as a deleted flow", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockRejectedValue(new Error("box down"));
      const { db } = trackedDb({ data: null, error: null });
      await expect(getAiFlow(BIZ, "f1", db)).rejects.toThrow("box down");
    });

    it("the enqueue gates read the box, so a soft-deleted flow still refuses runs", async () => {
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockResolvedValue([
        { definition: null, deleted_at: "2026-08-20T00:00:00Z" }
      ] as never);
      const { db } = trackedDb({ data: null, error: null });
      expect(
        await enqueueAiFlowRun({ businessId: BIZ, flowId: "f1", trigger: {} }, db)
      ).toBeNull();
      expect(readMovedRows).toHaveBeenCalledWith(BIZ, {
        table: "ai_flows",
        columns: ["definition", "deleted_at"],
        filters: [
          { column: "business_id", op: "eq", value: BIZ },
          { column: "id", op: "eq", value: "f1" }
        ],
        limit: 1
      });
    });

    it("a flow row the box does not have leaves the gates open too", async () => {
      // Same contract as the throw case: no row means no gate, never a
      // silent refusal to enqueue.
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockResolvedValue([] as never);
      const insertChain: Record<string, unknown> = {};
      insertChain.select = vi.fn(() => insertChain);
      insertChain.single = vi.fn(async () => ({ data: { id: "r2" }, error: null }));
      const db = {
        from: vi.fn(() => ({
          insert: vi.fn(() => insertChain),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) }))
          }))
        }))
      } as never;
      expect(
        await enqueueAiFlowRun({ businessId: BIZ, flowId: "f1", trigger: {} }, db)
      ).toMatchObject({ id: "r2" });
    });

    it("an unreachable box leaves the gates open rather than losing the lead", async () => {
      // The documented contract on this read: a failure defaults both gates
      // to "no gate", because losing the lead is worse than a duplicate or a
      // burst. The box read joins that contract instead of overriding it, so
      // this must NOT throw and must NOT return null for a missing gate read.
      vi.mocked(isVpsReadMode).mockResolvedValue(true);
      vi.mocked(readMovedRows).mockRejectedValue(new Error("box down"));
      // Purpose-built stub: this is the one path that reaches the runs
      // INSERT, which the shared read-only tracker does not model.
      const insertChain: Record<string, unknown> = {};
      insertChain.select = vi.fn(() => insertChain);
      insertChain.single = vi.fn(async () => ({ data: { id: "r1" }, error: null }));
      const db = {
        from: vi.fn(() => ({
          insert: vi.fn(() => insertChain),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) }))
          }))
        }))
      } as never;
      const run = await enqueueAiFlowRun({ businessId: BIZ, flowId: "f1", trigger: {} }, db);
      expect(run).toMatchObject({ id: "r1" });
    });
  });

});
