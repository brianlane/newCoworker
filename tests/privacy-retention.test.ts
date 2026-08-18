import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/residency/read", () => ({
  residencyModeFor: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { pruneExpiredContent } from "@/lib/privacy/retention";
import { residencyModeFor } from "@/lib/residency/read";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "biz-1";
const NOW = new Date("2026-07-10T00:00:00.000Z");
const CUTOFF_90 = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

/** All tables the pruner touches, in execution order. */
const PRUNED_TABLES = [
  "email_log",
  "sms_outbound_log",
  "voice_call_transcripts",
  "voice_outbound_dial_log",
  "notifications",
  "scheduled_sms",
  "ai_reply_reasoning",
  "business_document_shares",
  "document_signature_requests",
  "sms_links",
  "ai_flow_notify_cooldowns",
  "sms_owner_reply_prompts",
  "webchat_sessions",
  "messenger_conversations",
  "messenger_messages",
  "sms_inbound_jobs",
  "lead_submissions",
  "booking_waitlist",
  "calendar_booking_dedupe",
  "voice_handoff_sessions"
] as const;

/** Central-only tables (not residency-moved): pruned with box: null. */
const CENTRAL_ONLY_TABLES = new Set<string>([
  "ai_reply_reasoning",
  "business_document_shares",
  "document_signature_requests",
  "sms_links",
  "ai_flow_notify_cooldowns",
  "webchat_sessions",
  "messenger_conversations",
  "messenger_messages",
  "sms_inbound_jobs",
  "lead_submissions",
  "booking_waitlist",
  "calendar_booking_dedupe",
  "voice_handoff_sessions"
]);

/** The subset that also lives on a residency box. */
const BOXED_TABLES = PRUNED_TABLES.filter((t) => !CENTRAL_ONLY_TABLES.has(t));

type TableResult = { data: unknown; error: { message: string } | null };

/**
 * Chainable central-db stub, same shape as the deletion suite's: every
 * builder method (including `.select()`) returns the chain, the chain is
 * THENABLE (one from() = one awaited result), and `perCall` maps
 * "<table>#<n>" (n = 1-based call index per table) or "<table>" to a
 * result so multi-round-trip blocks (messenger_conversations) can script
 * each operation.
 */
function makeCentralDb(
  perCall: Partial<Record<string, TableResult>> = {},
  storageRemove = vi.fn().mockResolvedValue({ error: null })
) {
  const seen = new Map<string, number>();
  const from = vi.fn((table: string) => {
    const n = (seen.get(table) ?? 0) + 1;
    seen.set(table, n);
    const result = perCall[`${table}#${n}`] ?? perCall[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["delete", "select", "eq", "lt", "gte", "in", "not", "neq", "or"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { from, storage: { from: vi.fn(() => ({ remove: storageRemove })) }, storageRemove };
}

function makeApi(overrides: Partial<{ select: unknown; delete: unknown }> = {}) {
  return {
    select: (overrides.select ??
      vi.fn().mockResolvedValue({ ok: true, rows: [] })) as never,
    delete: (overrides.delete ??
      vi.fn().mockResolvedValue({ ok: true, rows: [] })) as never
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(residencyModeFor).mockResolvedValue("supabase");
});

describe("pruneExpiredContent, central-only tenants", () => {
  it("prunes every table centrally and reports box: null", async () => {
    const db = makeCentralDb({
      email_log: { data: [{ id: "a" }, { id: "b" }], error: null },
      notifications: { data: null, error: null } // null payload → 0
    });
    const res = await pruneExpiredContent(BIZ, 90, {
      client: db as never,
      now: () => NOW
    });
    expect(res.cutoffIso).toBe(CUTOFF_90);
    expect(res.tables.map((t) => t.table)).toEqual([...PRUNED_TABLES]);
    expect(res.tables.every((t) => t.box === null)).toBe(true);
    expect(res.tables.find((t) => t.table === "email_log")?.central).toBe(2);
    expect(res.tables.find((t) => t.table === "notifications")?.central).toBe(0);
    // 20 central round trips (the messenger_conversations candidate scan
    // finds nothing by default, so its disqualify + delete never run), no
    // data-api construction.
    expect(db.from).toHaveBeenCalledTimes(20);
  });

  it("prunes only fully dead messenger conversations (in-window messages disqualify)", async () => {
    const db = makeCentralDb({
      // Two stale-timestamp candidates; c2 still has an in-window message
      // (an out-of-window template send), so only c1 dies.
      "messenger_conversations#1": { data: [{ id: "c1" }, { id: "c2" }], error: null },
      "messenger_messages#1": { data: [{ conversation_id: "c2" }], error: null },
      "messenger_conversations#2": { data: [{ id: "c1" }], error: null }
    });
    const res = await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(res.tables.find((t) => t.table === "messenger_conversations")?.central).toBe(1);
  });

  it("skips the messenger conversation delete when every candidate is still alive", async () => {
    const db = makeCentralDb({
      "messenger_conversations#1": { data: [{ id: "c1" }], error: null },
      "messenger_messages#1": { data: [{ conversation_id: "c1" }], error: null }
    });
    const res = await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(res.tables.find((t) => t.table === "messenger_conversations")?.central).toBe(0);
    // One conversation round trip only: the candidate scan; no delete runs.
    expect(
      db.from.mock.calls.filter((c) => c[0] === "messenger_conversations")
    ).toHaveLength(1);
  });

  it("treats null messenger scan payloads as empty (candidates and disqualify)", async () => {
    const nullCandidates = makeCentralDb({
      "messenger_conversations#1": { data: null, error: null }
    });
    const res1 = await pruneExpiredContent(BIZ, 90, { client: nullCandidates as never, now: () => NOW });
    expect(res1.tables.find((t) => t.table === "messenger_conversations")?.central).toBe(0);

    const nullRecent = makeCentralDb({
      "messenger_conversations#1": { data: [{ id: "c1" }], error: null },
      "messenger_messages#1": { data: null, error: null },
      "messenger_conversations#2": { data: [{ id: "c1" }], error: null }
    });
    const res2 = await pruneExpiredContent(BIZ, 90, { client: nullRecent as never, now: () => NOW });
    expect(res2.tables.find((t) => t.table === "messenger_conversations")?.central).toBe(1);
  });

  it("fails loudly when the messenger disqualify scan or delete errors", async () => {
    const scanFail = makeCentralDb({
      "messenger_conversations#1": { data: [{ id: "c1" }], error: null },
      "messenger_messages#1": { data: null, error: { message: "scan sad" } }
    });
    await expect(
      pruneExpiredContent(BIZ, 90, { client: scanFail as never, now: () => NOW })
    ).rejects.toThrow(/messenger_conversations: scan sad/);
    const deleteFail = makeCentralDb({
      "messenger_conversations#1": { data: [{ id: "c1" }], error: null },
      "messenger_messages#1": { data: [], error: null },
      "messenger_conversations#2": { data: null, error: { message: "del sad" } }
    });
    await expect(
      pruneExpiredContent(BIZ, 90, { client: deleteFail as never, now: () => NOW })
    ).rejects.toThrow(/messenger_conversations: del sad/);
  });

  it("removes attachment objects for pruned email rows, tolerating malformed shapes", async () => {
    const db = makeCentralDb({
      email_log: {
        data: [
          {
            id: "a",
            attachments: [
              { storage_path: "inbound/m1/0-file.pdf" },
              { storage_path: "" },
              { storage_path: 7 },
              "junk"
            ]
          },
          { id: "b", attachments: "not-an-array" },
          { id: "c" }
        ],
        error: null
      }
    });
    await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(db.storage.from).toHaveBeenCalledWith("email-attachments");
    expect(db.storageRemove).toHaveBeenCalledWith(["inbound/m1/0-file.pdf"]);
  });

  it("warns but does not throw when the attachment object removal fails", async () => {
    const storageRemove = vi.fn().mockResolvedValue({ error: { message: "bucket sad" } });
    const db = makeCentralDb(
      {
        email_log: {
          data: [{ id: "a", attachments: [{ storage_path: "inbound/m1/0-file.pdf" }] }],
          error: null
        }
      },
      storageRemove
    );
    const res = await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(res.tables.find((t) => t.table === "email_log")?.central).toBe(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "pruneExpiredContent: email-attachments storage remove failed",
      expect.objectContaining({ businessId: BIZ, objectCount: 1, error: "bucket sad" })
    );
  });

  it("skips the storage round trip when no pruned email row had attachments", async () => {
    const db = makeCentralDb({
      email_log: { data: [{ id: "a", attachments: [] }], error: null }
    });
    await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(db.storage.from).not.toHaveBeenCalled();
  });

  it("treats a null email_log delete payload as zero rows and zero attachments", async () => {
    const db = makeCentralDb({ email_log: { data: null, error: null } });
    const res = await pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW });
    expect(res.tables.find((t) => t.table === "email_log")?.central).toBe(0);
    expect(db.storage.from).not.toHaveBeenCalled();
  });

  it.each(PRUNED_TABLES)("throws loudly when the central delete on %s fails", async (table) => {
    const db = makeCentralDb({ [table]: { data: null, error: { message: "boom" } } });
    await expect(
      pruneExpiredContent(BIZ, 90, { client: db as never, now: () => NOW })
    ).rejects.toThrow(new RegExp(`${table}: boom`));
  });

  it("uses the default service client when none is injected", async () => {
    const db = makeCentralDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const res = await pruneExpiredContent(BIZ, 30, { now: () => NOW });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(res.retentionDays).toBe(30);
  });
});

describe("pruneExpiredContent, residency (dual/vps) tenants", () => {
  it("also prunes on the box, including the explicit transcript-turns pass", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    const apiSelect = vi
      .fn()
      .mockResolvedValue({ ok: true, rows: [{ id: "t-1" }, { id: "t-2" }] });
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "x" }] });
    const api = makeApi({ select: apiSelect, delete: apiDelete });

    const res = await pruneExpiredContent(BIZ, 90, {
      client: db as never,
      dataApiFor: () => api,
      now: () => NOW
    });

    // Turns are deleted by transcript id BEFORE the parents.
    expect(apiDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "voice_call_transcript_turns",
        filters: [{ column: "transcript_id", op: "in", value: ["t-1", "t-2"] }]
      })
    );
    // Every box-resident table got a box delete scoped to the business;
    // the central-only tables report box: null.
    for (const table of BOXED_TABLES) {
      expect(apiDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          table,
          filters: expect.arrayContaining([
            { column: "business_id", op: "eq", value: BIZ }
          ])
        })
      );
    }
    expect(
      res.tables.every((t) =>
        CENTRAL_ONLY_TABLES.has(t.table) ? t.box === null : t.box === 1
      )
    ).toBe(true);
  });

  it("skips the turns pass when no box transcripts are expired", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("dual");
    const db = makeCentralDb();
    const apiDelete = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    const api = makeApi({ delete: apiDelete });
    await pruneExpiredContent(BIZ, 90, {
      client: db as never,
      dataApiFor: () => api,
      now: () => NOW
    });
    const turnsCalls = apiDelete.mock.calls.filter(
      (c) => (c[0] as { table: string }).table === "voice_call_transcript_turns"
    );
    expect(turnsCalls).toHaveLength(0);
  });

  it("fails loudly when a box delete reports ok:false", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    const api = makeApi({
      delete: vi.fn().mockResolvedValue({ ok: false, error: "internal", message: "box sad" })
    });
    await expect(
      pruneExpiredContent(BIZ, 90, {
        client: db as never,
        dataApiFor: () => api,
        now: () => NOW
      })
    ).rejects.toThrow(/box delete on email_log failed: box sad/);
  });

  it("fails loudly when the box transcript select reports ok:false", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    const api = makeApi({
      select: vi.fn().mockResolvedValue({ ok: false, error: "internal", message: "sel sad" })
    });
    await expect(
      pruneExpiredContent(BIZ, 90, {
        client: db as never,
        dataApiFor: () => api,
        now: () => NOW
      })
    ).rejects.toThrow(/box select on voice_call_transcripts failed: sel sad/);
  });

  it("fails loudly when the box turns delete reports ok:false", async () => {
    vi.mocked(residencyModeFor).mockResolvedValue("vps");
    const db = makeCentralDb();
    const apiSelect = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "t-1" }] });
    const apiDelete = vi.fn(async (req: { table: string }) =>
      req.table === "voice_call_transcript_turns"
        ? { ok: false, error: "internal", message: "turns sad" }
        : { ok: true, rows: [] }
    );
    await expect(
      pruneExpiredContent(BIZ, 90, {
        client: db as never,
        dataApiFor: () => makeApi({ select: apiSelect, delete: apiDelete }),
        now: () => NOW
      })
    ).rejects.toThrow(/box delete on voice_call_transcript_turns failed: turns sad/);
  });

  it("defaults `now` to the wall clock", async () => {
    const db = makeCentralDb();
    const before = Date.now();
    const res = await pruneExpiredContent(BIZ, 30, { client: db as never });
    const cutoff = new Date(res.cutoffIso).getTime();
    expect(cutoff).toBeGreaterThan(before - 31 * 24 * 60 * 60 * 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 30 * 24 * 60 * 60 * 1000);
  });
});
