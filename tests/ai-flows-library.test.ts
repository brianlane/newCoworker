import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  aggregateLibraryCandidates,
  getAiFlowLibraryEntry,
  listAiFlowLibrary,
  recordLibraryDownload,
  upsertLibraryEntry
} from "@/lib/ai-flows/library";

type StubErr = { message: string } | null;
type StubOpts = {
  array?: unknown;
  maybe?: unknown;
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
    Promise.resolve({ data: "array" in opts ? opts.array : [], error: opts.error ?? null }).then(
      resolve,
      reject
    );
  const db = {
    from: vi.fn(() => b),
    rpc: vi.fn(() => Promise.resolve({ data: opts.rpc ?? null, error: opts.rpcError ?? null }))
  };
  return { db, b };
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
  it("bumps an existing count", async () => {
    const { db, b } = makeDb({ maybe: { download_count: 4 } });
    await recordLibraryDownload(ROW.id, "biz-1", db as never);
    expect(b.update).toHaveBeenCalledWith({ download_count: 5 });
  });

  it("starts at 1 when no row/count exists", async () => {
    const { db, b } = makeDb({ maybe: null });
    await recordLibraryDownload(ROW.id, "biz-1", db as never);
    expect(b.update).toHaveBeenCalledWith({ download_count: 1 });
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
