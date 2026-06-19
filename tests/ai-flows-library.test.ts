import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  aggregateLibraryCandidates,
  getAiFlowLibraryEntry,
  listAiFlowLibrary,
  pruneLibraryEntries,
  recordLibraryDownload,
  upsertLibraryEntry
} from "@/lib/ai-flows/library";

type StubErr = { message: string } | null;
type StubOpts = {
  array?: unknown;
  maybe?: unknown;
  count?: number | null;
  error?: StubErr;
  rpc?: unknown;
  rpcError?: StubErr;
};

function makeDb(opts: StubOpts) {
  const b: any = {};
  for (const m of ["select", "insert", "update", "upsert", "eq", "in", "order"]) {
    b[m] = vi.fn(() => b);
  }
  b.maybeSingle = vi.fn(() => Promise.resolve({ data: opts.maybe ?? null, error: opts.error ?? null }));
  b.then = (resolve: any, reject: any) =>
    Promise.resolve({
      data: "array" in opts ? opts.array : [],
      count: "count" in opts ? opts.count : undefined,
      error: opts.error ?? null
    }).then(resolve, reject);
  const db = {
    from: vi.fn(() => b),
    rpc: vi.fn(() => Promise.resolve({ data: opts.rpc ?? null, error: opts.rpcError ?? null }))
  };
  return { db, b };
}

// Prune needs independent results for the SELECT (existing rows) and the DELETE,
// which a single shared builder can't express.
function makePruneDb(opts: {
  selectData?: unknown;
  selectError?: StubErr;
  deleteError?: StubErr;
}) {
  const selectChain: any = {
    select: vi.fn(() => selectChain),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: opts.selectData ?? null, error: opts.selectError ?? null }).then(
        resolve,
        reject
      )
  };
  const deleteChain: any = {
    delete: vi.fn(() => deleteChain),
    in: vi.fn(() => deleteChain),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ error: opts.deleteError ?? null }).then(resolve, reject)
  };
  const b = { select: selectChain.select, delete: deleteChain.delete };
  return { db: { from: vi.fn(() => b) }, deleteChain };
}

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  template_key: "referralexchange-lead",
  title: "ReferralExchange lead",
  summary: "When SMS: send_sms",
  category: "Real estate",
  scrubbed_definition: { version: 1 },
  total_successful_runs: 9,
  total_runs: 12,
  businesses_using: 3,
  runs_last_7d: 7,
  download_count: 2,
  last_run_at: "2026-06-18T00:00:00Z",
  stats: { runsPerDay: 1 },
  first_published_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-18T00:00:00Z"
};

beforeEach(() => vi.clearAllMocks());

describe("listAiFlowLibrary", () => {
  it("returns rows without a category filter and creates a client when none passed", async () => {
    const { db, b } = makeDb({ array: [ROW] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listAiFlowLibrary()).toEqual([ROW]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(b.eq).not.toHaveBeenCalled();
  });

  it("applies a category filter", async () => {
    const { db, b } = makeDb({ array: [ROW] });
    expect(await listAiFlowLibrary({ category: "Real estate" }, db as never)).toEqual([ROW]);
    expect(b.eq).toHaveBeenCalledWith("category", "Real estate");
  });

  it("defaults to empty when data is null", async () => {
    const { db } = makeDb({ array: null });
    expect(await listAiFlowLibrary({}, db as never)).toEqual([]);
  });

  it("throws on error", async () => {
    const { db } = makeDb({ array: null, error: { message: "boom" } });
    await expect(listAiFlowLibrary({}, db as never)).rejects.toThrow("listAiFlowLibrary: boom");
  });
});

describe("getAiFlowLibraryEntry", () => {
  it("looks up by id for a uuid", async () => {
    const { db, b } = makeDb({ maybe: ROW });
    expect(await getAiFlowLibraryEntry(ROW.id, db as never)).toEqual(ROW);
    expect(b.eq).toHaveBeenCalledWith("id", ROW.id);
  });

  it("looks up by template_key for a non-uuid", async () => {
    const { db, b } = makeDb({ maybe: ROW });
    expect(await getAiFlowLibraryEntry("referralexchange-lead", db as never)).toEqual(ROW);
    expect(b.eq).toHaveBeenCalledWith("template_key", "referralexchange-lead");
  });

  it("returns null when missing", async () => {
    const { db } = makeDb({ maybe: null });
    expect(await getAiFlowLibraryEntry("nope", db as never)).toBeNull();
  });

  it("throws on error", async () => {
    const { db } = makeDb({ maybe: null, error: { message: "bad" } });
    await expect(getAiFlowLibraryEntry("nope", db as never)).rejects.toThrow(
      "getAiFlowLibraryEntry: bad"
    );
  });
});

describe("recordLibraryDownload", () => {
  it("sets download_count to the authoritative row count", async () => {
    const { db, b } = makeDb({ count: 5 });
    await recordLibraryDownload(ROW.id, "biz-1", db as never);
    expect(b.insert).toHaveBeenCalledWith({ library_id: ROW.id, business_id: "biz-1" });
    expect(b.update).toHaveBeenCalledWith({ download_count: 5 });
  });

  it("leaves download_count untouched when the count is null", async () => {
    const { db, b } = makeDb({ count: null });
    await recordLibraryDownload(ROW.id, "biz-1", db as never);
    expect(b.update).not.toHaveBeenCalled();
  });

  it("leaves download_count untouched when the count query errors", async () => {
    const { db, b } = makeDb({ count: 3, error: { message: "count boom" } });
    await recordLibraryDownload(ROW.id, "biz-1", db as never);
    expect(b.update).not.toHaveBeenCalled();
  });
});

describe("pruneLibraryEntries", () => {
  it("deletes entries whose template_key is not kept", async () => {
    const { db, deleteChain } = makePruneDb({
      selectData: [
        { id: "a", template_key: "keep-me" },
        { id: "b", template_key: "stale" }
      ]
    });
    const removed = await pruneLibraryEntries(["keep-me"], db as never);
    expect(removed).toBe(1);
    expect(deleteChain.in).toHaveBeenCalledWith("id", ["b"]);
  });

  it("removes everything when no keys are kept", async () => {
    const { db, deleteChain } = makePruneDb({
      selectData: [{ id: "a", template_key: "x" }]
    });
    expect(await pruneLibraryEntries([], db as never)).toBe(1);
    expect(deleteChain.in).toHaveBeenCalledWith("id", ["a"]);
  });

  it("returns 0 and skips delete when nothing is stale", async () => {
    const { db, deleteChain } = makePruneDb({ selectData: [{ id: "a", template_key: "keep" }] });
    expect(await pruneLibraryEntries(["keep"], db as never)).toBe(0);
    expect(deleteChain.in).not.toHaveBeenCalled();
  });

  it("defaults to empty when the select returns null", async () => {
    const { db } = makePruneDb({ selectData: null });
    expect(await pruneLibraryEntries(["keep"], db as never)).toBe(0);
  });

  it("throws when the select fails", async () => {
    const { db } = makePruneDb({ selectError: { message: "sel boom" } });
    await expect(pruneLibraryEntries(["k"], db as never)).rejects.toThrow(
      "pruneLibraryEntries: sel boom"
    );
  });

  it("throws when the delete fails", async () => {
    const { db } = makePruneDb({
      selectData: [{ id: "b", template_key: "stale" }],
      deleteError: { message: "del boom" }
    });
    await expect(pruneLibraryEntries(["keep"], db as never)).rejects.toThrow(
      "pruneLibraryEntries: del boom"
    );
  });
});

describe("aggregateLibraryCandidates", () => {
  it("returns rpc rows", async () => {
    const rows = [{ flow_id: "f1" }];
    const { db } = makeDb({ rpc: rows });
    expect(await aggregateLibraryCandidates(db as never)).toEqual(rows);
  });

  it("defaults to empty when rpc data is null", async () => {
    const { db } = makeDb({ rpc: null });
    expect(await aggregateLibraryCandidates(db as never)).toEqual([]);
  });

  it("throws on rpc error", async () => {
    const { db } = makeDb({ rpcError: { message: "rpc boom" } });
    await expect(aggregateLibraryCandidates(db as never)).rejects.toThrow(
      "aggregateLibraryCandidates: rpc boom"
    );
  });
});

describe("upsertLibraryEntry", () => {
  const base = {
    templateKey: "k",
    title: "T",
    summary: "S",
    category: "C",
    scrubbedDefinition: { version: 1 },
    totalSuccessfulRuns: 1,
    totalRuns: 2,
    businessesUsing: 1,
    runsLast7d: 1,
    lastRunAt: null
  };

  it("upserts with explicit stats", async () => {
    const { db, b } = makeDb({});
    await upsertLibraryEntry({ ...base, stats: { runsPerDay: 3 } }, db as never);
    expect(b.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ template_key: "k", stats: { runsPerDay: 3 } }),
      { onConflict: "template_key" }
    );
  });

  it("defaults stats to an empty object", async () => {
    const { db, b } = makeDb({});
    await upsertLibraryEntry(base, db as never);
    expect(b.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ stats: {} }),
      { onConflict: "template_key" }
    );
  });

  it("throws on error", async () => {
    const { db } = makeDb({ error: { message: "up boom" } });
    await expect(upsertLibraryEntry(base, db as never)).rejects.toThrow(
      "upsertLibraryEntry: up boom"
    );
  });
});
