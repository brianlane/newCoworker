import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

const { loggerWarn, loggerInfo, loggerError } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, info: loggerInfo, error: loggerError, debug: vi.fn() }
}));

import {
  chunkJournalRows,
  deleteFiltersFor,
  normalizeBatchColumns,
  runResidencyReplay,
  type JournalRow
} from "@/lib/residency/replay";
import { DataApiClient, DataApiTransportError } from "@/lib/residency/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

function row(seq: number, overrides: Partial<JournalRow> = {}): JournalRow {
  return {
    seq,
    business_id: BIZ,
    table_name: "contacts",
    op: "upsert",
    payload: { id: `row-${seq}`, business_id: BIZ },
    attempts: 0,
    ...overrides
  };
}

/**
 * Supabase mock covering the replayer's five query shapes: the pending rpc,
 * the business mode read, the pending rows read, journal delete (by seq or
 * rollback-skip), and the failure bookkeeping (update + bump rpc).
 */
function makeDb(opts: {
  pendingBusinesses?: string[] | null | { error: string };
  mode?: string | null | { error: string };
  pending?: JournalRow[] | null | { error: string };
  rollbackSkipCount?: number;
  rollbackError?: string;
  deleteError?: string;
  failMarkError?: string;
  bumpError?: string;
}) {
  const state = {
    deletedSeqs: [] as number[][],
    failedSeqs: [] as number[][],
    bumpedSeqs: [] as number[][],
    rollbackDeleted: 0
  };
  const client = {
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === "residency_pending_businesses") {
        if (opts.pendingBusinesses && !Array.isArray(opts.pendingBusinesses)) {
          return { data: null, error: { message: opts.pendingBusinesses.error } };
        }
        return { data: opts.pendingBusinesses === undefined ? [] : opts.pendingBusinesses, error: null };
      }
      if (opts.bumpError) return { data: null, error: { message: opts.bumpError } };
      state.bumpedSeqs.push((args?.p_seqs as number[]) ?? []);
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === "businesses") {
        const maybeSingle = vi.fn(async () => {
          if (opts.mode && typeof opts.mode === "object") {
            return { data: null, error: { message: opts.mode.error } };
          }
          return {
            data: opts.mode === null ? null : { tier: "enterprise", data_residency_mode: opts.mode ?? "dual" },
            error: null
          };
        });
        const eq = vi.fn(() => ({ maybeSingle }));
        return { select: vi.fn(() => ({ eq })) };
      }
      // residency_write_journal
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(async () => {
                  if (opts.pending && !Array.isArray(opts.pending)) {
                    return { data: null, error: { message: opts.pending.error } };
                  }
                  return {
                    data: opts.pending === undefined ? [] : opts.pending,
                    error: null
                  };
                })
              }))
            }))
          }))
        })),
        update: vi.fn(() => ({
          in: vi.fn(async (_col: string, seqs: number[]) => {
            if (opts.failMarkError) return { error: { message: opts.failMarkError } };
            state.failedSeqs.push(seqs);
            return { error: null };
          })
        })),
        delete: vi.fn(() => ({
          in: vi.fn(async (_col: string, seqs: number[]) => {
            if (opts.deleteError) return { error: { message: opts.deleteError } };
            state.deletedSeqs.push(seqs);
            return { error: null };
          }),
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              select: vi.fn(async () => {
                if (opts.rollbackError) {
                  return { data: null, error: { message: opts.rollbackError } };
                }
                if (opts.rollbackSkipCount === undefined) {
                  // PostgREST can answer a delete+select with null data.
                  return { data: null, error: null };
                }
                return {
                  data: Array.from({ length: opts.rollbackSkipCount }, (_, i) => ({ seq: i })),
                  error: null
                };
              })
            }))
          }))
        }))
      };
    })
  };
  return { client: client as never, state };
}

function makeApi(handlers: {
  insert?: (req: unknown) => Promise<{ ok: boolean; error?: string; message?: string; rows: unknown[] }>;
  delete?: (req: unknown) => Promise<{ ok: boolean; error?: string; message?: string; rows: unknown[] }>;
}) {
  return {
    insert: vi.fn(handlers.insert ?? (async () => ({ ok: true, rows: [] }))),
    delete: vi.fn(handlers.delete ?? (async () => ({ ok: true, rows: [] })))
  } as unknown as DataApiClient;
}

describe("chunkJournalRows", () => {
  it("batches consecutive same-table upserts and isolates deletes", () => {
    const rows = [
      row(1),
      row(2),
      row(3, { table_name: "email_log" }),
      row(4, { table_name: "email_log", op: "delete" }),
      row(5, { table_name: "email_log" })
    ];
    const chunks = chunkJournalRows(rows, 100);
    expect(chunks.map((c) => c.map((r) => r.seq))).toEqual([[1, 2], [3], [4], [5]]);
  });

  it("splits batches at batchSize", () => {
    const rows = [row(1), row(2), row(3)];
    expect(chunkJournalRows(rows, 2).map((c) => c.length)).toEqual([2, 1]);
  });
});

describe("deleteFiltersFor", () => {
  it("builds PK equality filters, composite keys included", () => {
    expect(
      deleteFiltersFor("sms_rowboat_threads", { business_id: BIZ, customer_e164: "+1555" })
    ).toEqual([
      { column: "business_id", op: "eq", value: BIZ },
      { column: "customer_e164", op: "eq", value: "+1555" }
    ]);
  });

  it("throws when the payload is missing a PK column (absent or null)", () => {
    expect(() => deleteFiltersFor("contacts", { business_id: BIZ })).toThrow(/missing PK/);
    expect(() => deleteFiltersFor("contacts", { id: null })).toThrow(/missing PK/);
  });
});

describe("normalizeBatchColumns", () => {
  it("unions columns across rows, null-filling gaps", () => {
    expect(normalizeBatchColumns([{ a: 1 }, { b: 2 }])).toEqual([
      { a: 1, b: null },
      { a: null, b: 2 }
    ]);
  });
});

describe("runResidencyReplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays pending upserts as PK-conflict batches and deletes journal rows", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1), row(2), row(3, { op: "delete", payload: { id: "row-3" } })]
    });
    const api = makeApi({});
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    expect(summary.totalReplayed).toBe(3);
    expect(summary.totalErrors).toBe(0);
    expect(api.insert).toHaveBeenCalledWith({
      table: "contacts",
      rows: [
        { id: "row-1", business_id: BIZ },
        { id: "row-2", business_id: BIZ }
      ],
      onConflict: ["id"],
      returning: false
    });
    expect(api.delete).toHaveBeenCalledWith({
      table: "contacts",
      filters: [{ column: "id", op: "eq", value: "row-3" }],
      returning: false
    });
    expect(state.deletedSeqs).toEqual([[1, 2], [3]]);
  });

  it("stops the business at the first failing batch, preserving order", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1), row(2, { table_name: "email_log" })]
    });
    const api = makeApi({
      insert: async (req) => {
        if ((req as { table: string }).table === "contacts") {
          return { ok: false, error: "internal", message: "pg down", rows: [] };
        }
        return { ok: true, rows: [] };
      }
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    expect(summary.totalReplayed).toBe(0);
    expect(summary.totalErrors).toBe(1);
    expect(summary.businesses[0].stoppedAt).toBe(1);
    // Only the failing batch is marked; the later row is untouched.
    expect(state.failedSeqs).toEqual([[1]]);
    expect(state.bumpedSeqs).toEqual([[1]]);
    expect(api.insert).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      "residency-replay: business drain stopped",
      expect.objectContaining({ businessId: BIZ, stoppedAt: 1 })
    );
  });

  it("treats a transport error (down box) the same way", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "vps",
      pending: [row(1)]
    });
    const api = makeApi({
      insert: async () => {
        throw new DataApiTransportError("data-api unreachable");
      }
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    expect(summary.totalErrors).toBe(1);
    expect(summary.businesses[0].error).toContain("unreachable");
    expect(state.failedSeqs).toEqual([[1]]);
  });

  it("purges the queue for a tenant rolled back to supabase mode", async () => {
    const { client } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "supabase",
      rollbackSkipCount: 4
    });
    const api = makeApi({});
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    expect(summary.totalSkipped).toBe(4);
    expect(summary.totalReplayed).toBe(0);
    expect(api.insert).not.toHaveBeenCalled();
  });

  it("a journal row for a non-moved table stops the business loudly", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1, { table_name: "businesses" })]
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => makeApi({}) });
    expect(summary.totalErrors).toBe(1);
    expect(summary.businesses[0].error).toContain("unknown moved table");
    expect(state.failedSeqs).toEqual([[1]]);
  });

  it("surfaces business lookup and pending fetch failures without throwing", async () => {
    const lookupFail = makeDb({ pendingBusinesses: [BIZ], mode: { error: "biz-boom" } });
    const s1 = await runResidencyReplay({
      client: lookupFail.client,
      makeDataApi: () => makeApi({})
    });
    expect(s1.businesses[0].error).toContain("biz-boom");

    const pendingFail = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: { error: "pend-boom" }
    });
    const s2 = await runResidencyReplay({
      client: pendingFail.client,
      makeDataApi: () => makeApi({})
    });
    expect(s2.businesses[0].error).toContain("pend-boom");
  });

  it("throws when the pending-businesses rpc itself fails", async () => {
    const { client } = makeDb({ pendingBusinesses: { error: "rpc-boom" } });
    await expect(
      runResidencyReplay({ client, makeDataApi: () => makeApi({}) })
    ).rejects.toThrow(/rpc-boom/);
  });

  it("a failed journal delete after a successful replay propagates (rows will re-replay as idempotent upserts)", async () => {
    const { client } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1)],
      deleteError: "journal delete down"
    });
    await expect(
      runResidencyReplay({ client, makeDataApi: () => makeApi({}) })
    ).rejects.toThrow(/journal delete down/);
  });

  it("caps the businesses processed per run", async () => {
    const { client } = makeDb({
      pendingBusinesses: [BIZ, "22222222-2222-4222-8222-222222222222"],
      mode: "dual",
      pending: []
    });
    const summary = await runResidencyReplay({
      client,
      makeDataApi: () => makeApi({}),
      businessLimit: 1
    });
    expect(summary.businesses).toHaveLength(1);
  });

  it("a failing DELETE op stops the business the same as a failing upsert", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1, { op: "delete", payload: { id: "row-1" } }), row(2)]
    });
    const api = makeApi({
      delete: async () => ({ ok: false, error: "internal", message: "pg down", rows: [] })
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    expect(summary.totalErrors).toBe(1);
    expect(summary.businesses[0].stoppedAt).toBe(1);
    expect(state.failedSeqs).toEqual([[1]]);
    expect(api.insert).not.toHaveBeenCalled();
  });

  it("failure bookkeeping degrades to warnings when the journal itself errors", async () => {
    const { client, state } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1)],
      failMarkError: "update down",
      bumpError: "bump down"
    });
    const api = makeApi({
      insert: async () => ({ ok: false, error: "internal", message: "boom", rows: [] })
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => api });
    // The drain still stops and reports; the bookkeeping failures are logged.
    expect(summary.totalErrors).toBe(1);
    expect(state.failedSeqs).toEqual([]);
    expect(loggerWarn).toHaveBeenCalledWith(
      "residency-replay: failed to record batch error",
      expect.objectContaining({ error: "update down" })
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      "residency-replay: attempts bump failed",
      expect.objectContaining({ error: "bump down" })
    );
  });

  it("a missing business row defaults to supabase mode (purge path, null-safe)", async () => {
    // makeDb with mode:null returns no business row AND a null delete+select
    // payload — both `??` fallbacks in the rollback path fire.
    const { client } = makeDb({ pendingBusinesses: [BIZ], mode: null });
    const summary = await runResidencyReplay({ client, makeDataApi: () => makeApi({}) });
    expect(summary.businesses[0]).toEqual({ businessId: BIZ, replayed: 0, skipped: 0 });
  });

  it("surfaces a rollback-purge failure as the business error", async () => {
    const { client } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "supabase",
      rollbackError: "purge down"
    });
    const summary = await runResidencyReplay({ client, makeDataApi: () => makeApi({}) });
    expect(summary.businesses[0].error).toContain("purge down");
  });

  it("constructs the default DataApiClient per business (default makeDataApi path)", async () => {
    // Rollback purge never touches the API, so the default client is safe to
    // instantiate for real here.
    const { client } = makeDb({
      pendingBusinesses: [BIZ],
      mode: "supabase",
      rollbackSkipCount: 1
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const summary = await runResidencyReplay({ client });
    expect(summary.totalSkipped).toBe(1);
  });

  it("uses no-op defaults when nothing is pending (default deps path)", async () => {
    const { client } = makeDb({ pendingBusinesses: [] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client);
    const summary = await runResidencyReplay();
    expect(summary).toEqual({
      businesses: [],
      totalReplayed: 0,
      totalSkipped: 0,
      totalErrors: 0
    });
  });

  it("tolerates null payloads from the rpc and the pending read", async () => {
    const rpcNull = makeDb({ pendingBusinesses: null });
    const s1 = await runResidencyReplay({ client: rpcNull.client, makeDataApi: () => makeApi({}) });
    expect(s1.businesses).toHaveLength(0);

    const pendingNull = makeDb({ pendingBusinesses: [BIZ], mode: "dual", pending: null });
    const s2 = await runResidencyReplay({
      client: pendingNull.client,
      makeDataApi: () => makeApi({})
    });
    expect(s2.businesses[0]).toEqual({ businessId: BIZ, replayed: 0, skipped: 0 });
  });

  it("wraps a plain-Error and a non-Error throw from the drain", async () => {
    // Plain Error: a delete journal row with a broken payload (missing PK).
    const badDelete = makeDb({
      pendingBusinesses: [BIZ],
      mode: "dual",
      pending: [row(1, { op: "delete", payload: {} })]
    });
    const s1 = await runResidencyReplay({
      client: badDelete.client,
      makeDataApi: () => makeApi({})
    });
    expect(s1.businesses[0].error).toContain("missing PK");

    // Non-Error throw from the data api client.
    const weird = makeDb({ pendingBusinesses: [BIZ], mode: "dual", pending: [row(1)] });
    const api = makeApi({
      insert: async () => {
        throw "string bomb";
      }
    });
    const s2 = await runResidencyReplay({ client: weird.client, makeDataApi: () => api });
    expect(s2.businesses[0].error).toBe("string bomb");
  });
});
