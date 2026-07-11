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
  "sms_owner_reply_prompts"
] as const;

/** Central-only tables (never on a residency box). */
const CENTRAL_ONLY_TABLES = new Set(["ai_reply_reasoning", "business_document_shares"]);

/** The subset that also lives on a residency box. */
const BOXED_TABLES = PRUNED_TABLES.filter((t) => !CENTRAL_ONLY_TABLES.has(t));

type TableResult = { data: unknown; error: { message: string } | null };

/**
 * Chainable central-db stub: every builder method returns the chain and
 * `.select()` resolves with the table's configured result.
 */
function makeCentralDb(perTable: Partial<Record<string, TableResult>> = {}) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["delete", "eq", "lt", "in", "not", "or"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.select = vi.fn().mockResolvedValue(result);
    return chain;
  });
  return { from };
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

describe("pruneExpiredContent — central-only tenants", () => {
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
    // 9 central deletes, no data-api construction.
    expect(db.from).toHaveBeenCalledTimes(9);
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

describe("pruneExpiredContent — residency (dual/vps) tenants", () => {
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
    // the central-only ai_reply_reasoning reports box: null.
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
      res.tables.every((t) => (CENTRAL_ONLY_TABLES.has(t.table) ? t.box === null : t.box === 1))
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
