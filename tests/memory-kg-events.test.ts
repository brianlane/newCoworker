/**
 * KG retrieval ledger (src/lib/memory/kg-events.ts): PostgREST wire shapes
 * for record/list/prune/summary, and the pure comparison analytics — the
 * verdict matrix, aggregation, per-business grouping, and the headline —
 * that /admin/memory-graph renders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  KG_EVENTS_RETENTION_DAYS,
  aggregateKgStats,
  classifyKgVerdict,
  getKgAdminSummary,
  groupKgStatsByBusiness,
  kgVerdictHeadline,
  listKgRetrievalEvents,
  listKgRetrievalStatsRows,
  pruneKgRetrievalEvents,
  recordKgRetrievalEvent,
  type KgRetrievalEventInsert
} from "@/lib/memory/kg-events";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

type Chain = Record<string, ReturnType<typeof vi.fn>>;

function chain(result: { data?: unknown; error?: unknown; count?: number | null }, terminal: string): Chain {
  const c: Chain = {};
  for (const m of ["from", "select", "insert", "delete", "eq", "gte", "lt", "order", "limit", "maybeSingle"]) {
    c[m] = vi.fn(() => (m === terminal ? Promise.resolve(result) : c));
  }
  return c;
}

function insertRow(overrides: Partial<KgRetrievalEventInsert> = {}): KgRetrievalEventInsert {
  return {
    business_id: BIZ,
    mode: "shadow",
    question: "what are your hours?",
    answer: "9-5 weekdays",
    graph_context: "",
    memory_context: "- hours 9-5",
    graph_matched_entities: 0,
    graph_facts: 0,
    graph_context_chars: 0,
    memory_context_chars: 11,
    memory_selected: 1,
    memory_from_archive: 0,
    memory_fallback: false,
    caller_provided: false,
    ...overrides
  };
}

describe("recordKgRetrievalEvent", () => {
  it("inserts into kg_retrieval_events", async () => {
    const c = chain({ error: null }, "insert");
    await recordKgRetrievalEvent(insertRow(), c as never);
    expect(c.from).toHaveBeenCalledWith("kg_retrieval_events");
    expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ business_id: BIZ }));
  });

  it("throws on error and supports the default client", async () => {
    const failing = chain({ error: { message: "denied" } }, "insert");
    await expect(recordKgRetrievalEvent(insertRow(), failing as never)).rejects.toThrow(
      "recordKgRetrievalEvent: denied"
    );
    const ok = chain({ error: null }, "insert");
    defaultClientSpy.mockReturnValue(ok);
    await recordKgRetrievalEvent(insertRow());
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("listKgRetrievalEvents / listKgRetrievalStatsRows", () => {
  it("filters by business + window, newest first, bounded", async () => {
    const c = chain({ data: [{ id: "e1" }], error: null }, "limit");
    const rows = await listKgRetrievalEvents(BIZ, "2026-07-01T00:00:00Z", 50, c as never);
    expect(rows).toEqual([{ id: "e1" }]);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.gte).toHaveBeenCalledWith("created_at", "2026-07-01T00:00:00Z");
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(50);
  });

  it("maps null data to [], throws on error, supports the default client", async () => {
    const failing = chain({ data: null, error: { message: "bad" } }, "limit");
    await expect(listKgRetrievalEvents(BIZ, "2026-07-01T00:00:00Z", 50, failing as never)).rejects.toThrow(
      "listKgRetrievalEvents: bad"
    );
    const empty = chain({ data: null, error: null }, "limit");
    defaultClientSpy.mockReturnValue(empty);
    expect(await listKgRetrievalEvents(BIZ, "2026-07-01T00:00:00Z")).toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });

  it("stats rows select the compact column list fleet-wide", async () => {
    const c = chain({ data: [{ business_id: BIZ }], error: null }, "limit");
    const rows = await listKgRetrievalStatsRows("2026-07-01T00:00:00Z", 100, c as never);
    expect(rows).toEqual([{ business_id: BIZ }]);
    expect(c.select).toHaveBeenCalledWith(expect.stringContaining("graph_context_chars"));
    expect(c.gte).toHaveBeenCalledWith("created_at", "2026-07-01T00:00:00Z");
  });

  it("stats rows: null → [], error throws, default client works", async () => {
    const failing = chain({ data: null, error: { message: "bad" } }, "limit");
    await expect(listKgRetrievalStatsRows("2026-07-01T00:00:00Z", 10, failing as never)).rejects.toThrow(
      "listKgRetrievalStatsRows: bad"
    );
    const empty = chain({ data: null, error: null }, "limit");
    defaultClientSpy.mockReturnValue(empty);
    expect(await listKgRetrievalStatsRows("2026-07-01T00:00:00Z")).toEqual([]);
  });
});

describe("pruneKgRetrievalEvents", () => {
  it("deletes rows older than the fixed retention window", async () => {
    const c = chain({ data: [{ id: "a" }, { id: "b" }], error: null }, "select");
    const now = new Date("2026-07-23T00:00:00Z");
    const deleted = await pruneKgRetrievalEvents(now, c as never);
    expect(deleted).toBe(2);
    const cutoff = new Date(
      now.getTime() - KG_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    expect(c.lt).toHaveBeenCalledWith("created_at", cutoff);
  });

  it("maps null data to 0, throws on error, supports the default client + clock", async () => {
    const failing = chain({ data: null, error: { message: "locked" } }, "select");
    await expect(pruneKgRetrievalEvents(new Date(), failing as never)).rejects.toThrow(
      "pruneKgRetrievalEvents: locked"
    );
    const empty = chain({ data: null, error: null }, "select");
    defaultClientSpy.mockReturnValue(empty);
    expect(await pruneKgRetrievalEvents()).toBe(0);
  });
});

describe("getKgAdminSummary", () => {
  function summaryDb(opts: {
    entities?: { count: number | null; error?: { message: string } | null };
    facts?: { count: number | null; error?: { message: string } | null };
    event?: { data: unknown; error?: { message: string } | null };
  }) {
    const from = vi.fn((table: string) => {
      if (table === "memory_entities") {
        // Preserve `count: null` exactly — the module's `?? 0` is under test.
        const result = {
          count: opts.entities === undefined ? 0 : opts.entities.count,
          error: opts.entities?.error ?? null
        };
        const c: Chain = {};
        for (const m of ["select"]) c[m] = vi.fn(() => c);
        c.eq = vi.fn(() => Promise.resolve(result));
        return c;
      }
      if (table === "memory_facts") {
        const result = {
          count: opts.facts === undefined ? 0 : opts.facts.count,
          error: opts.facts?.error ?? null
        };
        const c: Chain = {};
        c.select = vi.fn(() => c);
        let eqCalls = 0;
        c.eq = vi.fn(() => {
          eqCalls += 1;
          return eqCalls === 2 ? Promise.resolve(result) : c;
        });
        return c;
      }
      const result = { data: opts.event?.data ?? null, error: opts.event?.error ?? null };
      const c: Chain = {};
      for (const m of ["select", "eq", "order", "limit"]) c[m] = vi.fn(() => c);
      c.maybeSingle = vi.fn(() => Promise.resolve(result));
      return c;
    });
    return { from };
  }

  it("returns counts and the latest event timestamp", async () => {
    const db = summaryDb({
      entities: { count: 7 },
      facts: { count: 3 },
      event: { data: { created_at: "2026-07-22T10:00:00Z" } }
    });
    expect(await getKgAdminSummary(BIZ, db as never)).toEqual({
      entityCount: 7,
      factCount: 3,
      lastEventAt: "2026-07-22T10:00:00Z"
    });
  });

  it("null counts/rows → zeros and null; errors throw; default client works", async () => {
    const db = summaryDb({
      entities: { count: null },
      facts: { count: null },
      event: { data: null }
    });
    expect(await getKgAdminSummary(BIZ, db as never)).toEqual({
      entityCount: 0,
      factCount: 0,
      lastEventAt: null
    });

    await expect(
      getKgAdminSummary(BIZ, summaryDb({ entities: { count: null, error: { message: "x" } } }) as never)
    ).rejects.toThrow("getKgAdminSummary(entities): x");
    await expect(
      getKgAdminSummary(BIZ, summaryDb({ facts: { count: null, error: { message: "y" } } }) as never)
    ).rejects.toThrow("getKgAdminSummary(facts): y");
    await expect(
      getKgAdminSummary(BIZ, summaryDb({ event: { data: null, error: { message: "z" } } }) as never)
    ).rejects.toThrow("getKgAdminSummary(events): z");

    defaultClientSpy.mockReturnValue(summaryDb({}));
    expect((await getKgAdminSummary(BIZ)).entityCount).toBe(0);
  });
});

describe("classifyKgVerdict", () => {
  it("covers the full matrix", () => {
    // Graph hit, memory fell back (or empty) → graph was the only relevant source.
    expect(
      classifyKgVerdict({ graph_context_chars: 10, memory_context_chars: 50, memory_fallback: true })
    ).toBe("graph_won");
    expect(
      classifyKgVerdict({ graph_context_chars: 10, memory_context_chars: 0, memory_fallback: false })
    ).toBe("graph_won");
    // Both contributed question-relevant context.
    expect(
      classifyKgVerdict({ graph_context_chars: 10, memory_context_chars: 50, memory_fallback: false })
    ).toBe("both");
    // Memory answered, graph silent.
    expect(
      classifyKgVerdict({ graph_context_chars: 0, memory_context_chars: 50, memory_fallback: false })
    ).toBe("memory_only");
    // Nothing relevant anywhere (fallback filler or empty).
    expect(
      classifyKgVerdict({ graph_context_chars: 0, memory_context_chars: 50, memory_fallback: true })
    ).toBe("neither");
    expect(
      classifyKgVerdict({ graph_context_chars: 0, memory_context_chars: 0, memory_fallback: false })
    ).toBe("neither");
  });
});

describe("aggregateKgStats / groupKgStatsByBusiness / kgVerdictHeadline", () => {
  const events = [
    // graph_won
    { business_id: "b1", graph_context_chars: 100, memory_context_chars: 200, memory_fallback: true, caller_provided: true },
    // both
    { business_id: "b1", graph_context_chars: 50, memory_context_chars: 300, memory_fallback: false, caller_provided: false },
    // memory_only
    { business_id: "b1", graph_context_chars: 0, memory_context_chars: 100, memory_fallback: false, caller_provided: false },
    // neither
    { business_id: "b2", graph_context_chars: 0, memory_context_chars: 0, memory_fallback: false, caller_provided: false }
  ];

  it("aggregates verdicts, rates, and averages", () => {
    const stats = aggregateKgStats(events);
    expect(stats.lookups).toBe(4);
    expect(stats.verdicts).toEqual({ graph_won: 1, both: 1, memory_only: 1, neither: 1 });
    expect(stats.graphContributionRate).toBe(50);
    expect(stats.graphOnlyRate).toBe(25);
    expect(stats.avgGraphChars).toBe(38); // (100+50+0+0)/4 = 37.5 → 38
    expect(stats.avgMemoryChars).toBe(150);
    expect(stats.memoryFallbackRate).toBe(25);
    expect(stats.callerScopedRate).toBe(25);
  });

  it("handles the empty window", () => {
    const stats = aggregateKgStats([]);
    expect(stats.lookups).toBe(0);
    expect(stats.graphContributionRate).toBe(0);
    expect(stats.avgGraphChars).toBe(0);
    expect(kgVerdictHeadline(stats)).toContain("No lookups recorded");
  });

  it("groups per business", () => {
    const grouped = groupKgStatsByBusiness(events);
    expect(grouped.get("b1")?.lookups).toBe(3);
    expect(grouped.get("b2")?.lookups).toBe(1);
    expect(grouped.get("b2")?.verdicts.neither).toBe(1);
  });

  it("renders the at-a-glance headline", () => {
    const line = kgVerdictHeadline(aggregateKgStats(events));
    expect(line).toContain("Graph contributed on 50% of 4 lookups");
    expect(line).toContain("only relevant source on 25%");
    expect(line).toContain("fell back to filler on 25%");
  });
});
