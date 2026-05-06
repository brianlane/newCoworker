import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for src/lib/customer-memory/db.ts.
 *
 * The module is a thin wrapper around Supabase's PostgREST client, so
 * the goal here is twofold:
 *   (a) Pin the wire-level shape we send to PostgREST — column lists,
 *       order/limit, search filter escaping, RPC arg names — so a
 *       casual edit (e.g. typo'ing `customer_memories` or renaming
 *       a column) breaks a fast unit test rather than failing in
 *       prod.
 *   (b) Lock the PostgREST `.or()` filter escaping for the search
 *       parameter (Cursor Bugbot Medium on PR #74). Without an
 *       explicit assertion, a future "simplification" could
 *       reintroduce the comma/dot injection bug.
 *
 * We mock the entire SupabaseClient surface — the real one is too
 * heavyweight for unit tests and pulls in network. The mock returns
 * `{ data, error }` shapes identical to Supabase's runtime contract
 * so any signature drift here surfaces in production-shaped tests.
 */

import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  deleteCustomerMemory,
  getCustomerMemory,
  listCustomerMemories,
  listSmsHistoryForCustomer,
  recordInteractionAndIncrement,
  updateCustomerOwnerFields,
  updateCustomerSummary
} from "../src/lib/customer-memory/db";
import type { CustomerMemoryRow } from "../src/lib/customer-memory/types";

const BIZ = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "+15555550123";

afterEach(() => {
  vi.restoreAllMocks();
});

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: CUSTOMER,
    display_name: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

/**
 * Minimal chainable PostgREST builder. Records every method call so
 * tests can assert column lists, filter ordering, etc.
 */
type CallLog = { name: string; args: unknown[] };

function makeBuilder(terminator: { data?: unknown; error?: unknown } | (() => Promise<unknown>)) {
  const calls: CallLog[] = [];
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "eq",
    "neq",
    "or",
    "order",
    "limit",
    "filter"
  ];
  for (const m of chainMethods) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ name: m, args });
      return builder;
    };
  }
  builder["maybeSingle"] = async () => {
    calls.push({ name: "maybeSingle", args: [] });
    return typeof terminator === "function" ? await terminator() : terminator;
  };
  builder["single"] = async () => {
    calls.push({ name: "single", args: [] });
    return typeof terminator === "function" ? await terminator() : terminator;
  };
  // The "terminal" awaited result for queries that don't call
  // .maybeSingle() (e.g. listCustomerMemories awaits the whole chain).
  builder["then"] = (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    return Promise.resolve(typeof terminator === "function" ? terminator() : terminator).then(
      resolve,
      reject
    );
  };
  return { builder, calls };
}

function makeClient(opts: {
  fromTerminator?: { data?: unknown; error?: unknown };
  rpcResult?: { data?: unknown; error?: unknown };
}) {
  const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const client = {
    from(table: string) {
      const { builder, calls } = makeBuilder(opts.fromTerminator ?? { data: null, error: null });
      fromCalls.push({ table, calls });
      return builder;
    },
    async rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return opts.rpcResult ?? { data: null, error: null };
    }
  } as unknown as Parameters<typeof getCustomerMemory>[2];
  return { client, fromCalls, rpcCalls };
}

describe("getCustomerMemory", () => {
  it("queries customer_memories with the full column projection and (business_id, customer_e164) filter", async () => {
    const row = memory({ display_name: "Joe" });
    const { client, fromCalls } = makeClient({
      fromTerminator: { data: row, error: null }
    });

    const result = await getCustomerMemory(BIZ, CUSTOMER, client);
    expect(result).toEqual(row);

    const fr = fromCalls[0]!;
    expect(fr.table).toBe("customer_memories");
    // Column list pinning: changing this list MUST be a deliberate
    // schema migration, not a casual edit.
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("display_name");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("summary_md");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("pinned_md");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("interaction_count");
    // Both filter eq() calls are present.
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs).toHaveLength(2);
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["customer_e164", CUSTOMER]);
    // maybeSingle() — null when missing, never throws on 0 rows.
    expect(fr.calls.find((c) => c.name === "maybeSingle")).toBeDefined();
  });

  it("returns null when no row exists", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    expect(await getCustomerMemory(BIZ, CUSTOMER, client)).toBeNull();
  });

  it("throws with the underlying PostgREST error on lookup failure", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls denied" } }
    });
    await expect(getCustomerMemory(BIZ, CUSTOMER, client)).rejects.toThrow(
      /getCustomerMemory: rls denied/
    );
  });
});

describe("listCustomerMemories", () => {
  it("clamps limit to [1, MAX_LIST_LIMIT] and defaults to DEFAULT_LIST_LIMIT", async () => {
    const { client, fromCalls } = makeClient({
      fromTerminator: { data: [], error: null }
    });
    await listCustomerMemories(BIZ, {}, client);
    expect(fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(DEFAULT_LIST_LIMIT);

    const c2 = makeClient({ fromTerminator: { data: [], error: null } });
    await listCustomerMemories(BIZ, { limit: 9999 }, c2.client);
    expect(c2.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(MAX_LIST_LIMIT);

    const c3 = makeClient({ fromTerminator: { data: [], error: null } });
    await listCustomerMemories(BIZ, { limit: 0 }, c3.client);
    expect(c3.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(1);

    const c4 = makeClient({ fromTerminator: { data: [], error: null } });
    await listCustomerMemories(BIZ, { limit: -5 }, c4.client);
    expect(c4.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(1);
  });

  it("orders by last_interaction_at desc with nullsFirst=false (recency, never strand never-contacted rows at top)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
    await listCustomerMemories(BIZ, {}, client);
    const order = fromCalls[0]?.calls.find((c) => c.name === "order");
    expect(order?.args[0]).toBe("last_interaction_at");
    expect(order?.args[1]).toEqual({ ascending: false, nullsFirst: false });
  });

  it("does NOT add an .or() filter when search is omitted or empty/whitespace", async () => {
    for (const search of [undefined, "", "   "]) {
      const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
      await listCustomerMemories(BIZ, { search }, client);
      expect(fromCalls[0]?.calls.find((c) => c.name === "or")).toBeUndefined();
    }
  });

  it("wraps the search pattern in DOUBLE QUOTES per PostgREST spec — fixes comma/dot injection (Bugbot Medium)", async () => {
    // The bug being pinned: a search of "Smith, LLC" or "127.0.0.1"
    // would split into multiple .or() conditions because PostgREST
    // treats commas as condition separators and dots as
    // field/operator/value delimiters. The fix is to wrap each value
    // in double quotes so PostgREST parses them as literals.
    const cases: Array<{ input: string; pattern: string }> = [
      { input: "Smith, LLC", pattern: `"%Smith, LLC%"` },
      { input: "127.0.0.1", pattern: `"%127.0.0.1%"` },
      { input: 'Joe "the Plumber"', pattern: `"%Joe \\"the Plumber\\"%"` },
      // SQL LIKE wildcards still escaped beneath the quoting layer.
      { input: "100%", pattern: `"%100\\%%"` },
      { input: "snake_case", pattern: `"%snake\\_case%"` },
      // Plain alphanumerics get the same quoting treatment for
      // consistency — the cost is negligible vs. the safety win.
      { input: "Joe", pattern: `"%Joe%"` }
    ];
    for (const { input, pattern } of cases) {
      const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
      await listCustomerMemories(BIZ, { search: input }, client);
      const orCall = fromCalls[0]?.calls.find((c) => c.name === "or");
      expect(orCall, `case ${input}`).toBeDefined();
      expect(String(orCall?.args[0])).toBe(
        `display_name.ilike.${pattern},customer_e164.ilike.${pattern}`
      );
    }
  });

  it("returns empty array on null data and propagates PostgREST errors", async () => {
    const empty = makeClient({ fromTerminator: { data: null, error: null } });
    expect(await listCustomerMemories(BIZ, {}, empty.client)).toEqual([]);

    const errored = makeClient({
      fromTerminator: { data: null, error: { message: "boom" } }
    });
    await expect(listCustomerMemories(BIZ, {}, errored.client)).rejects.toThrow(
      /listCustomerMemories: boom/
    );
  });
});

describe("recordInteractionAndIncrement", () => {
  it("calls the record_customer_interaction RPC with the four expected positional args", async () => {
    const row = memory({ interaction_count: 1, total_interaction_count: 1, last_channel: "sms" });
    const { client, rpcCalls } = makeClient({ rpcResult: { data: [row], error: null } });
    const result = await recordInteractionAndIncrement(
      BIZ,
      CUSTOMER,
      "sms",
      { displayName: "Joe" },
      client
    );
    expect(result).toEqual(row);
    expect(rpcCalls[0]?.name).toBe("record_customer_interaction");
    expect(rpcCalls[0]?.args).toEqual({
      p_business_id: BIZ,
      p_customer_e164: CUSTOMER,
      p_channel: "sms",
      p_display_name: "Joe"
    });
  });

  it("passes p_display_name=null when displayName is omitted (no client-side magic)", async () => {
    const { client, rpcCalls } = makeClient({
      rpcResult: { data: memory(), error: null }
    });
    await recordInteractionAndIncrement(BIZ, CUSTOMER, "voice", {}, client);
    expect(rpcCalls[0]?.args).toMatchObject({ p_display_name: null, p_channel: "voice" });
  });

  it("unwraps the RPC's array return shape OR a single-row return — Postgres functions returning SETOF can do either", async () => {
    const row = memory();
    const arrClient = makeClient({ rpcResult: { data: [row], error: null } });
    expect(await recordInteractionAndIncrement(BIZ, CUSTOMER, "sms", {}, arrClient.client)).toEqual(
      row
    );

    const singleClient = makeClient({ rpcResult: { data: row, error: null } });
    expect(
      await recordInteractionAndIncrement(BIZ, CUSTOMER, "sms", {}, singleClient.client)
    ).toEqual(row);
  });

  it("throws when the RPC errors", async () => {
    const { client } = makeClient({
      rpcResult: { data: null, error: { message: "rpc broken" } }
    });
    await expect(recordInteractionAndIncrement(BIZ, CUSTOMER, "sms", {}, client)).rejects.toThrow(
      /recordInteractionAndIncrement: rpc broken/
    );
  });

  it("throws when the RPC returns no row (treats null as a logic bug, not 'silently insert nothing')", async () => {
    const { client } = makeClient({ rpcResult: { data: null, error: null } });
    await expect(recordInteractionAndIncrement(BIZ, CUSTOMER, "sms", {}, client)).rejects.toThrow(
      /rpc returned no row/
    );
  });
});

describe("updateCustomerSummary", () => {
  it("UPDATEs summary_md, resets interaction_count to 0, sets last_summarized_at + updated_at, scoped to (biz, customer)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerSummary(
      BIZ,
      CUSTOMER,
      { summaryMd: "Joe wants a garage door spring.", resetCounter: true },
      client
    );
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("customer_memories");
    const updateCall = fr.calls.find((c) => c.name === "update");
    expect(updateCall?.args[0]).toMatchObject({
      summary_md: "Joe wants a garage door spring.",
      interaction_count: 0
    });
    expect((updateCall?.args[0] as Record<string, unknown>).last_summarized_at).toBeTruthy();
    expect((updateCall?.args[0] as Record<string, unknown>).updated_at).toBeTruthy();
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["customer_e164", CUSTOMER]);
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "no perms" } }
    });
    await expect(
      updateCustomerSummary(BIZ, CUSTOMER, { summaryMd: "x", resetCounter: true }, client)
    ).rejects.toThrow(/updateCustomerSummary: no perms/);
  });
});

describe("updateCustomerOwnerFields", () => {
  it("only patches the fields the owner provided — never touches summary_md/counters/last_*", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { displayName: "Joe Plumber", pinnedMd: "VIP — wife is allergic to nuts." },
      client
    );
    const updateCall = fromCalls[0]!.calls.find((c) => c.name === "update");
    const patch = updateCall?.args[0] as Record<string, unknown>;
    expect(patch.display_name).toBe("Joe Plumber");
    expect(patch.pinned_md).toBe("VIP — wife is allergic to nuts.");
    expect(patch.updated_at).toBeTruthy();
    expect(patch).not.toHaveProperty("summary_md");
    expect(patch).not.toHaveProperty("interaction_count");
  });

  it("supports clearing display_name / pinned_md by passing null (UI 'clear' button)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: null, pinnedMd: null }, client);
    const patch = fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch.display_name).toBeNull();
    expect(patch.pinned_md).toBeNull();
  });

  it("partial edit: providing only displayName does not write pinned_md (avoids clobbering owner notes)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, client);
    const patch = fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch).toHaveProperty("display_name", "Joe");
    expect(patch).not.toHaveProperty("pinned_md");
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls" } }
    });
    await expect(
      updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "x" }, client)
    ).rejects.toThrow(/updateCustomerOwnerFields: rls/);
  });
});

describe("deleteCustomerMemory", () => {
  it("DELETEs scoped to (business_id, customer_e164) — never an unscoped delete", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await deleteCustomerMemory(BIZ, CUSTOMER, client);
    const fr = fromCalls[0]!;
    expect(fr.calls.find((c) => c.name === "delete")).toBeDefined();
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs).toHaveLength(2);
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["customer_e164", CUSTOMER]);
  });

  it("propagates PostgREST errors so the API surface returns a real status to the owner UI", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "fk violation" } }
    });
    await expect(deleteCustomerMemory(BIZ, CUSTOMER, client)).rejects.toThrow(
      /deleteCustomerMemory: fk violation/
    );
  });
});

describe("listSmsHistoryForCustomer", () => {
  function jobRow(overrides: Partial<{
    id: string;
    payload: Record<string, unknown>;
    rowboat_reply_cached: string | null;
    created_at: string;
  }> = {}) {
    return {
      id: "j-1",
      payload: { data: { payload: { text: "hi" } } },
      rowboat_reply_cached: "hello",
      created_at: "2026-05-01T00:00:00Z",
      ...overrides
    };
  }

  it("queries sms_inbound_jobs scoped to (business_id, customer_e164) ordered desc, limit clamped", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
    await listSmsHistoryForCustomer(BIZ, CUSTOMER, { limit: 5 }, client);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("sms_inbound_jobs");
    expect(fr.calls.find((c) => c.name === "limit")?.args[0]).toBe(5);
    expect(fr.calls.find((c) => c.name === "order")?.args).toEqual([
      "created_at",
      { ascending: false }
    ]);
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["customer_e164", CUSTOMER]);
  });

  it("clamps limit to [1, 100] with a 30 default", async () => {
    const a = makeClient({ fromTerminator: { data: [], error: null } });
    await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, a.client);
    expect(a.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(30);

    const b = makeClient({ fromTerminator: { data: [], error: null } });
    await listSmsHistoryForCustomer(BIZ, CUSTOMER, { limit: 9999 }, b.client);
    expect(b.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(100);

    const c = makeClient({ fromTerminator: { data: [], error: null } });
    await listSmsHistoryForCustomer(BIZ, CUSTOMER, { limit: -1 }, c.client);
    expect(c.fromCalls[0]?.calls.find((c) => c.name === "limit")?.args[0]).toBe(1);
  });

  it("flips DB-newest-first to chronological order so summarizer prompts read in conversation order", async () => {
    const { client } = makeClient({
      fromTerminator: {
        data: [
          jobRow({ id: "newest", created_at: "2026-05-03T00:00:00Z" }),
          jobRow({ id: "middle", created_at: "2026-05-02T00:00:00Z" }),
          jobRow({ id: "oldest", created_at: "2026-05-01T00:00:00Z" })
        ],
        error: null
      }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result.map((r) => r.jobId)).toEqual(["oldest", "middle", "newest"]);
  });

  it("extracts inbound text from Telnyx 'text' OR 'body' field (different API versions)", async () => {
    const { client } = makeClient({
      fromTerminator: {
        data: [
          jobRow({ id: "a", payload: { data: { payload: { text: "from text key" } } } }),
          jobRow({ id: "b", payload: { data: { payload: { body: "from body key" } } } }),
          // Malformed shape: empty inboundText (we don't throw — we degrade gracefully).
          jobRow({ id: "c", payload: {} })
        ],
        error: null
      }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    // Note: result is reversed (chronological), so DB index 0 -> result last.
    expect(result.find((r) => r.jobId === "a")?.inboundText).toBe("from text key");
    expect(result.find((r) => r.jobId === "b")?.inboundText).toBe("from body key");
    expect(result.find((r) => r.jobId === "c")?.inboundText).toBe("");
  });

  it("normalizes assistantReply: empty/whitespace-only strings become null (so consumers can `?? '[no reply]'`)", async () => {
    const { client } = makeClient({
      fromTerminator: {
        data: [
          jobRow({ id: "a", rowboat_reply_cached: "real reply" }),
          jobRow({ id: "b", rowboat_reply_cached: "" }),
          jobRow({ id: "c", rowboat_reply_cached: "   " }),
          jobRow({ id: "d", rowboat_reply_cached: null })
        ],
        error: null
      }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result.find((r) => r.jobId === "a")?.assistantReply).toBe("real reply");
    expect(result.find((r) => r.jobId === "b")?.assistantReply).toBeNull();
    expect(result.find((r) => r.jobId === "c")?.assistantReply).toBeNull();
    expect(result.find((r) => r.jobId === "d")?.assistantReply).toBeNull();
  });

  it("returns empty array when DB returns no rows", async () => {
    const a = makeClient({ fromTerminator: { data: [], error: null } });
    expect(await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, a.client)).toEqual([]);

    const b = makeClient({ fromTerminator: { data: null, error: null } });
    expect(await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, b.client)).toEqual([]);
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls" } }
    });
    await expect(listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client)).rejects.toThrow(
      /listSmsHistoryForCustomer: rls/
    );
  });
});
