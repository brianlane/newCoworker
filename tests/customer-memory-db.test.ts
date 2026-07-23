import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
// Mock the default-client factory so tests calling helpers WITHOUT
// the third `client` arg exercise the `client ?? (await
// createSupabaseServiceClient())` fallback. Mirrors the pattern used
// in tests/db-voice-transcripts.test.ts.
vi.mock("@/lib/memory/graph-deterministic", () => ({
  ingestContact: vi.fn(async () => ({ ran: false })),
  ingestPinnedNote: vi.fn(async () => ({ ran: false }))
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

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
  CustomerExistsError,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  createCustomerMemory,
  deleteCustomerMemory,
  findCustomerByEmail,
  getCustomerMemory,
  linkCustomerEmail,
  listCustomerMemories,
  listSmsHistoryForCustomer,
  touchLastSummarizedAt,
  mergeCustomerMemories,
  recordInteractionAndIncrement,
  setContactSmsReplyMode,
  updateCustomerOwnerFields,
  updateCustomerSummary
} from "../src/lib/customer-memory/db";
import { createSupabaseServiceClient } from "../src/lib/supabase/server";
import { normalizeContactTags, type CustomerMemoryRow } from "../src/lib/customer-memory/types";
import { ingestContact, ingestPinnedNote } from "@/lib/memory/graph-deterministic";

const BIZ = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "+15555550123";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: CUSTOMER,
    type: "customer",
    name_source: "auto",
    sms_reply_mode: "auto",
    display_name: null,
    email: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    alias_e164s: [],
    tags: [],
    owner_employee_id: null,
    birthday: null,
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
    "ilike",
    "is",
    "in",
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
  /** Per-table override; falls back to `fromTerminator` for other tables. */
  tableTerminators?: Record<string, { data?: unknown; error?: unknown }>;
  rpcResult?: { data?: unknown; error?: unknown };
}) {
  const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const client = {
    from(table: string) {
      const terminator =
        opts.tableTerminators?.[table] ?? opts.fromTerminator ?? { data: null, error: null };
      const { builder, calls } = makeBuilder(terminator);
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
  it("queries customer_memories with the full column projection and an alias-aware (e164 OR alias) filter", async () => {
    const row = memory({ display_name: "Joe" });
    const { client, fromCalls } = makeClient({
      fromTerminator: { data: row, error: null }
    });

    const result = await getCustomerMemory(BIZ, CUSTOMER, client);
    expect(result).toEqual(row);

    const fr = fromCalls[0]!;
    expect(fr.table).toBe("contacts");
    // Column list pinning: changing this list MUST be a deliberate
    // schema migration, not a casual edit.
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("display_name");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("summary_md");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("pinned_md");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("interaction_count");
    expect(fr.calls.find((c) => c.name === "select")?.args[0]).toContain("alias_e164s");
    // business scope via eq(); the number matches customer_e164 OR a
    // merged-away alias (merge_customer_memories) via .or().
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs).toHaveLength(1);
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(fr.calls.find((c) => c.name === "or")?.args[0]).toBe(
      `customer_e164.eq.${CUSTOMER},alias_e164s.cs.{${CUSTOMER}}`
    );
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

describe("linkCustomerEmail", () => {
  // linkCustomerEmail calls `from("customer_memories")` up to twice: an
  // alias-aware SELECT, then either an UPDATE (by id) or a minimal INSERT. A
  // sequence client hands each from() call its own terminator so we can model
  // "row exists / has email / missing" independently.
  function makeSeqClient(terminators: Array<{ data?: unknown; error?: unknown }>) {
    const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
    let i = 0;
    const client = {
      from(table: string) {
        const terminator = terminators[i++] ?? { data: null, error: null };
        const { builder, calls } = makeBuilder(terminator);
        fromCalls.push({ table, calls });
        return builder;
      }
    } as unknown as Parameters<typeof linkCustomerEmail>[3];
    return { client, fromCalls };
  }

  it("no-ops on a blank email without touching the DB", async () => {
    const { client, fromCalls } = makeSeqClient([]);
    await linkCustomerEmail(BIZ, CUSTOMER, "   ", client);
    expect(fromCalls).toHaveLength(0);
  });

  it("resolves the contact alias-aware (e164 OR alias) before writing", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: { id: "row-1", email: null }, error: null },
      { data: null, error: null }
    ]);
    await linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client);
    const sel = fromCalls[0]!;
    expect(sel.calls.find((c) => c.name === "or")?.args[0]).toBe(
      `customer_e164.eq.${CUSTOMER},alias_e164s.cs.{${CUSTOMER}}`
    );
  });

  it("fills an empty email on the matched row by id (never inserts)", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: { id: "row-1", email: null }, error: null },
      { data: null, error: null }
    ]);
    await linkCustomerEmail(BIZ, CUSTOMER, "  joe@acme.com  ", client);
    expect(fromCalls).toHaveLength(2);
    const upd = fromCalls[1]!;
    const updateArg = upd.calls.find((c) => c.name === "update")?.args[0] as Record<string, unknown>;
    expect(updateArg.email).toBe("joe@acme.com");
    // Targets the resolved row id (covers the merged-alias case).
    expect(upd.calls.find((c) => c.name === "eq")?.args).toEqual(["id", "row-1"]);
  });

  it("leaves an existing email untouched (never clobbers an owner edit)", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: { id: "row-1", email: "owner@set.com" }, error: null }
    ]);
    await linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client);
    // Only the SELECT ran — no UPDATE, no INSERT.
    expect(fromCalls).toHaveLength(1);
  });

  it("inserts a minimal profile when no row exists", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    await linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client);
    expect(fromCalls).toHaveLength(2);
    const ins = fromCalls[1]!;
    const insertArg = ins.calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({
      business_id: BIZ,
      customer_e164: CUSTOMER,
      email: "joe@acme.com"
    });
  });

  it("on insert unique-violation, fills the racing row's email (alias-aware, only-if-null)", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: null, error: null }, // SELECT: no row yet
      { data: null, error: { code: "23505", message: "duplicate key" } }, // INSERT loses the race
      { data: null, error: null } // recovery UPDATE
    ]);
    await expect(linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client)).resolves.toBeUndefined();
    expect(fromCalls).toHaveLength(3);
    const recover = fromCalls[2]!;
    expect(recover.calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      email: "joe@acme.com"
    });
    expect(recover.calls.find((c) => c.name === "or")?.args[0]).toBe(
      `customer_e164.eq.${CUSTOMER},alias_e164s.cs.{${CUSTOMER}}`
    );
    // Never clobber an owner-set value: the recovery update is gated on email IS NULL.
    expect(recover.calls.find((c) => c.name === "is")?.args).toEqual(["email", null]);
  });

  it("throws when the post-violation recovery update errors", async () => {
    const { client } = makeSeqClient([
      { data: null, error: null },
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: null, error: { message: "recover boom" } }
    ]);
    await expect(linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client)).rejects.toThrow(
      /linkCustomerEmail: recover boom/
    );
  });

  it("throws on a non-unique insert error", async () => {
    const { client } = makeSeqClient([
      { data: null, error: null },
      { data: null, error: { code: "42501", message: "rls denied" } }
    ]);
    await expect(linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client)).rejects.toThrow(
      /linkCustomerEmail: rls denied/
    );
  });

  it("throws on a select error", async () => {
    const { client } = makeSeqClient([{ data: null, error: { message: "select boom" } }]);
    await expect(linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client)).rejects.toThrow(
      /linkCustomerEmail: select boom/
    );
  });

  it("throws on an update error", async () => {
    const { client } = makeSeqClient([
      { data: { id: "row-1", email: null }, error: null },
      { data: null, error: { message: "update boom" } }
    ]);
    await expect(linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com", client)).rejects.toThrow(
      /linkCustomerEmail: update boom/
    );
  });

  it("falls back to the default service client when none is provided", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: { id: "row-1", email: "x@y.com" }, error: null }
    ]);
    defaultClientSpy.mockReturnValueOnce(client);
    await linkCustomerEmail(BIZ, CUSTOMER, "joe@acme.com");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(fromCalls).toHaveLength(1);
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
    // field/operator/value delimiters. The fix wraps each value in
    // double quotes so PostgREST parses them as literals AND
    // backslash-escapes any embedded `"` or `\` so the quoting can't
    // be broken by user input.
    //
    // Two layers of escaping run in order:
    //   (1) SQL LIKE: %, _ → \%, \_ so a search of "100%" matches the
    //       literal % rather than "anything starting with 100".
    //   (2) PostgREST literal: " → \", \ → \\, applied AFTER step (1)
    //       so the backslashes step (1) introduced get doubled.
    //       PostgREST collapses every `\<c>` sequence inside double-
    //       quoted values to `<c>` before handing the value to
    //       Postgres LIKE, so the LIKE escape only survives end-to-end
    //       when we double it here. Verified live against the REST
    //       surface — leaving step (2) at "only escape quote" causes
    //       a search for "100%" to also match "100abc" (regression
    //       caught by CodeQL high-severity "Incomplete string
    //       escaping" alert + a live escape test).
    const cases: Array<{ input: string; pattern: string }> = [
      { input: "Smith, LLC", pattern: `"%Smith, LLC%"` },
      { input: "127.0.0.1", pattern: `"%127.0.0.1%"` },
      { input: 'Joe "the Plumber"', pattern: `"%Joe \\"the Plumber\\"%"` },
      // SQL LIKE escape adds a backslash; the PostgREST escape then
      // doubles it (PostgREST collapses `\\` → `\` so LIKE receives
      // the escape sequence it needs).
      { input: "100%", pattern: `"%100\\\\%%"` },
      { input: "snake_case", pattern: `"%snake\\\\_case%"` },
      // Bare backslash from the user is also doubled.
      { input: "win\\path", pattern: `"%win\\\\path%"` },
      // Plain alphanumerics get the same quoting treatment for
      // consistency — the cost is negligible vs. the safety win.
      { input: "Joe", pattern: `"%Joe%"` }
    ];
    for (const { input, pattern } of cases) {
      const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
      await listCustomerMemories(BIZ, { search: input }, client);
      const orCall = fromCalls[0]?.calls.find((c) => c.name === "or");
      expect(orCall, `case ${JSON.stringify(input)}`).toBeDefined();
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

describe("createCustomerMemory", () => {
  it("inserts a profile (counters untouched / left to DB defaults) and returns the row", async () => {
    const row = memory({ display_name: "Joe", email: "joe@x.com" });
    const { client, fromCalls } = makeClient({ fromTerminator: { data: row, error: null } });
    const result = await createCustomerMemory(
      BIZ,
      { customerE164: CUSTOMER, displayName: "Joe", email: "joe@x.com", pinnedMd: "VIP" },
      client
    );
    expect(result).toEqual(row);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("contacts");
    const insert = fr.calls.find((c) => c.name === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      business_id: BIZ,
      customer_e164: CUSTOMER,
      display_name: "Joe",
      // Owner-typed name on "Add customer" → manual provenance.
      name_source: "manual",
      email: "joe@x.com",
      pinned_md: "VIP"
    });
    // Never fakes an interaction: no counter/last_channel keys in the insert.
    expect(insert).not.toHaveProperty("interaction_count");
    expect(insert).not.toHaveProperty("last_channel");
    expect(fr.calls.find((c) => c.name === "single")).toBeDefined();
  });

  it("sets `type` on the insert only when provided (omitted → DB default 'customer')", async () => {
    const { client, fromCalls } = makeClient({
      fromTerminator: { data: memory({ type: "company" }), error: null }
    });
    await createCustomerMemory(
      BIZ,
      { customerE164: CUSTOMER, displayName: "Lead Source", type: "company" },
      client
    );
    const insert = fromCalls[0]!.calls.find((c) => c.name === "insert")?.args[0] as Record<
      string,
      unknown
    >;
    expect(insert.type).toBe("company");
  });

  it("trims fields and coerces blank/omitted optionals to null", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: memory(), error: null } });
    await createCustomerMemory(
      BIZ,
      { customerE164: CUSTOMER, displayName: "   ", email: "  A@B.com  ", pinnedMd: "" },
      client
    );
    const insert = fromCalls[0]!.calls.find((c) => c.name === "insert")?.args[0] as Record<
      string,
      unknown
    >;
    expect(insert.display_name).toBeNull();
    // No name set → nothing to protect, stays at the DB default ('auto').
    expect(insert).not.toHaveProperty("name_source");
    expect(insert.email).toBe("A@B.com");
    expect(insert.pinned_md).toBeNull();
  });

  it("feeds the knowledge graph: contact node always, pinned-note fact when present", async () => {
    const { client } = makeClient({ fromTerminator: { data: memory(), error: null } });
    await createCustomerMemory(
      BIZ,
      { customerE164: CUSTOMER, displayName: "Joe", email: "joe@x.com", pinnedMd: "VIP" },
      client
    );
    expect(ingestContact).toHaveBeenCalledWith(BIZ, {
      displayName: "Joe",
      e164: CUSTOMER,
      email: "joe@x.com"
    });
    expect(ingestPinnedNote).toHaveBeenCalledWith(BIZ, {
      displayName: "Joe",
      e164: CUSTOMER,
      note: "VIP"
    });

    vi.mocked(ingestPinnedNote).mockClear();
    const { client: bare } = makeClient({ fromTerminator: { data: memory(), error: null } });
    await createCustomerMemory(BIZ, { customerE164: CUSTOMER }, bare);
    expect(ingestPinnedNote).not.toHaveBeenCalled();
  });

  it("throws CustomerExistsError on the unique-violation SQLSTATE so the API can 409", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { code: "23505", message: "duplicate key" } }
    });
    await expect(
      createCustomerMemory(BIZ, { customerE164: CUSTOMER }, client)
    ).rejects.toBeInstanceOf(CustomerExistsError);
  });

  it("rethrows other PostgREST errors with context", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { code: "12345", message: "rls" } }
    });
    await expect(createCustomerMemory(BIZ, { customerE164: CUSTOMER }, client)).rejects.toThrow(
      /createCustomerMemory: rls/
    );
  });
});

describe("findCustomerByEmail", () => {
  it("ilike-matches the escaped address then re-verifies exact (case-insensitive) equality in JS", async () => {
    const { client, fromCalls } = makeClient({
      fromTerminator: {
        data: [
          // A wildcard false-positive shape the JS verify must reject.
          { customer_e164: "+19999999999", display_name: "Imposter", email: "joeXsmith@x.com" },
          { customer_e164: CUSTOMER, display_name: "Joe", email: "JOE_smith@x.com" }
        ],
        error: null
      }
    });
    const result = await findCustomerByEmail(BIZ, "  joe_smith@x.com ", client);
    expect(result).toEqual({ customerE164: CUSTOMER, displayName: "Joe" });
    const fr = fromCalls[0]!;
    // `_` is escaped so it can't act as a single-char wildcard.
    expect(fr.calls.find((c) => c.name === "ilike")?.args).toEqual(["email", "joe\\_smith@x.com"]);
    expect(fr.calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
  });

  it("returns null without querying when the address is empty/whitespace", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
    expect(await findCustomerByEmail(BIZ, "   ", client)).toBeNull();
    expect(fromCalls).toHaveLength(0);
  });

  it("returns null when nothing matches (or only wildcard false-positives come back)", async () => {
    const { client } = makeClient({
      fromTerminator: {
        data: [
          // A row whose email is null exercises the `r.email ?? ""` guard.
          { customer_e164: "+1", display_name: null, email: null },
          { customer_e164: "+1", display_name: null, email: "someone-else@x.com" }
        ],
        error: null
      }
    });
    expect(await findCustomerByEmail(BIZ, "joe@x.com", client)).toBeNull();

    const nullData = makeClient({ fromTerminator: { data: null, error: null } });
    expect(await findCustomerByEmail(BIZ, "joe@x.com", nullData.client)).toBeNull();
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls" } }
    });
    await expect(findCustomerByEmail(BIZ, "joe@x.com", client)).rejects.toThrow(
      /findCustomerByEmail: rls/
    );
  });
});

describe("mergeCustomerMemories", () => {
  const FROM = "+15555550777";

  it("calls the merge_customer_memories RPC with the three expected positional args", async () => {
    const merged = memory({ alias_e164s: [FROM] });
    const { client, rpcCalls } = makeClient({ rpcResult: { data: merged, error: null } });
    const result = await mergeCustomerMemories(BIZ, FROM, CUSTOMER, client);
    expect(result).toEqual(merged);
    expect(rpcCalls[0]?.name).toBe("merge_customer_memories");
    expect(rpcCalls[0]?.args).toEqual({
      p_business_id: BIZ,
      p_from_e164: FROM,
      p_into_e164: CUSTOMER
    });
  });

  it("unwraps an array return shape (SETOF-style RPC results)", async () => {
    const merged = memory({ alias_e164s: [FROM] });
    const { client } = makeClient({ rpcResult: { data: [merged], error: null } });
    expect(await mergeCustomerMemories(BIZ, FROM, CUSTOMER, client)).toEqual(merged);
  });

  it("throws when the RPC errors (e.g. source row not found)", async () => {
    const { client } = makeClient({
      rpcResult: { data: null, error: { message: "source customer +1555 not found" } }
    });
    await expect(mergeCustomerMemories(BIZ, FROM, CUSTOMER, client)).rejects.toThrow(
      /mergeCustomerMemories: source customer/
    );
  });

  it("throws when the RPC returns no row", async () => {
    const { client } = makeClient({ rpcResult: { data: null, error: null } });
    await expect(mergeCustomerMemories(BIZ, FROM, CUSTOMER, client)).rejects.toThrow(
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
    expect(fr.table).toBe("contacts");
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

describe("touchLastSummarizedAt", () => {
  it("UPDATEs only last_summarized_at + updated_at (no summary write, no counter reset), scoped to (biz, customer)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await touchLastSummarizedAt(BIZ, CUSTOMER, client);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("contacts");
    const updateCall = fr.calls.find((c) => c.name === "update");
    const patch = updateCall?.args[0] as Record<string, unknown>;
    expect(patch.last_summarized_at).toBeTruthy();
    expect(patch.updated_at).toBeTruthy();
    // The skip stamp must never clobber the summary or the interaction
    // counter — it exists purely to rotate the sweep queue.
    expect(Object.keys(patch).sort()).toEqual(["last_summarized_at", "updated_at"]);
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["customer_e164", CUSTOMER]);
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls" } }
    });
    await expect(touchLastSummarizedAt(BIZ, CUSTOMER, client)).rejects.toThrow(
      /touchLastSummarizedAt: rls/
    );
  });
});

describe("normalizeContactTags", () => {
  it("trims, clamps length, drops empties, de-dups case-insensitively (first spelling wins)", () => {
    expect(normalizeContactTags(["  VIP ", "vip", "VIP", "", "  ", "Spanish"])).toEqual([
      "VIP",
      "Spanish"
    ]);
    const long = "x".repeat(100);
    expect(normalizeContactTags([long])[0]).toHaveLength(40);
  });
  it("caps at 25 tags", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag-${i}`);
    expect(normalizeContactTags(many)).toHaveLength(25);
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

  it("writes `type` when re-classifying a contact, and only when a truthy type is given", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { type: "company" }, client);
    const patch = fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch).toHaveProperty("type", "company");
    expect(patch).not.toHaveProperty("display_name");
  });

  it("writes email only when the key is present, and supports clearing it with null", async () => {
    const set = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { email: "joe@x.com" }, set.client);
    const setPatch = set.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(setPatch).toHaveProperty("email", "joe@x.com");
    expect(setPatch).not.toHaveProperty("display_name");

    const clear = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { email: null }, clear.client);
    const clearPatch = clear.fromCalls[0]!.calls.find((c) => c.name === "update")
      ?.args[0] as Record<string, unknown>;
    expect(clearPatch.email).toBeNull();

    // Absent key → never written (no clobber of an existing link).
    const skip = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, skip.client);
    const skipPatch = skip.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(skipPatch).not.toHaveProperty("email");
  });

  it("feeds the graph only on identity-bearing edits (name/email/pinned; never tags/type)", async () => {
    const identity = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { displayName: "Joe Plumber", pinnedMd: "VIP" },
      identity.client
    );
    expect(ingestContact).toHaveBeenCalledWith(BIZ, {
      displayName: "Joe Plumber",
      e164: CUSTOMER,
      email: null
    });
    expect(ingestPinnedNote).toHaveBeenCalledWith(BIZ, {
      displayName: "Joe Plumber",
      e164: CUSTOMER,
      note: "VIP"
    });

    vi.mocked(ingestContact).mockClear();
    vi.mocked(ingestPinnedNote).mockClear();

    // Pinned-only edit: note fact without a display name (falls back to the
    // number inside the builder); a null displayName clears no node.
    const pinnedOnly = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { pinnedMd: "gate code 4321" }, pinnedOnly.client);
    expect(ingestContact).not.toHaveBeenCalled();
    expect(ingestPinnedNote).toHaveBeenCalledWith(BIZ, {
      displayName: null,
      e164: CUSTOMER,
      note: "gate code 4321"
    });

    vi.mocked(ingestPinnedNote).mockClear();

    // Explicit name clear + note: the note still lands, nameless.
    const cleared = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { displayName: null, pinnedMd: "still useful" },
      cleared.client
    );
    expect(ingestPinnedNote).toHaveBeenCalledWith(BIZ, {
      displayName: null,
      e164: CUSTOMER,
      note: "still useful"
    });

    vi.mocked(ingestContact).mockClear();
    vi.mocked(ingestPinnedNote).mockClear();

    // High-frequency knobs never touch the graph; clearing pinned doesn't either.
    const knobs = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { tags: ["vip"], type: "company", pinnedMd: null },
      knobs.client
    );
    expect(ingestContact).not.toHaveBeenCalled();
    expect(ingestPinnedNote).not.toHaveBeenCalled();
  });

  it("writes normalized tags (trim, case-insensitive de-dup, drop empties)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { tags: ["  VIP ", "vip", "", "Spanish"] },
      client
    );
    const patch = fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch.tags).toEqual(["VIP", "Spanish"]);
  });

  it("assigns and clears owner_employee_id (null = release to unowned)", async () => {
    const MEMBER = "33333333-3333-4333-8333-333333333333";
    const set = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { ownerEmployeeId: MEMBER }, set.client);
    const setPatch = set.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(setPatch.owner_employee_id).toBe(MEMBER);

    const clear = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { ownerEmployeeId: null }, clear.client);
    const clearPatch = clear.fromCalls[0]!.calls.find((c) => c.name === "update")
      ?.args[0] as Record<string, unknown>;
    expect(clearPatch.owner_employee_id).toBeNull();

    // Absent key → never written.
    const skip = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, skip.client);
    const skipPatch = skip.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(skipPatch).not.toHaveProperty("owner_employee_id");
    expect(skipPatch).not.toHaveProperty("tags");
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

  it("partial edit: providing only pinnedMd does not write display_name (avoids clobbering owner-curated names)", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { pinnedMd: "VIP" }, client);
    const patch = fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch).toHaveProperty("pinned_md", "VIP");
    expect(patch).not.toHaveProperty("display_name");
  });

  it("stamps name_source when provided (owner edit = 'manual'), and omits it when absent", async () => {
    const withSource = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(
      BIZ,
      CUSTOMER,
      { displayName: "Amy (cell)", nameSource: "manual" },
      withSource.client
    );
    const patch = withSource.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch).toHaveProperty("name_source", "manual");
    expect(patch).toHaveProperty("display_name", "Amy (cell)");

    // Agent-discovered path omits nameSource → never upgrades provenance.
    const without = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, without.client);
    const plain = without.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(plain).not.toHaveProperty("name_source");
  });

  it("propagates PostgREST errors", async () => {
    const { client } = makeClient({
      fromTerminator: { data: null, error: { message: "rls" } }
    });
    await expect(
      updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "x" }, client)
    ).rejects.toThrow(/updateCustomerOwnerFields: rls/);
  });

  it("sets and clears the birthday (null = cleared), omits it when absent", async () => {
    const set = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { birthday: "1990-07-10" }, set.client);
    const setPatch = set.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(setPatch).toHaveProperty("birthday", "1990-07-10");

    const clear = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { birthday: null }, clear.client);
    const clearPatch = clear.fromCalls[0]!.calls.find((c) => c.name === "update")
      ?.args[0] as Record<string, unknown>;
    expect(clearPatch.birthday).toBeNull();

    const skip = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, skip.client);
    const skipPatch = skip.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(skipPatch).not.toHaveProperty("birthday");
  });

  it("writes sms_reply_mode when re-modding a contact, omits it when absent", async () => {
    const set = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { smsReplyMode: "suppress" }, set.client);
    const patch = set.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(patch).toHaveProperty("sms_reply_mode", "suppress");
    expect(patch).not.toHaveProperty("display_name");

    const skip = makeClient({ fromTerminator: { data: null, error: null } });
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "Joe" }, skip.client);
    const plain = skip.fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0] as Record<
      string,
      unknown
    >;
    expect(plain).not.toHaveProperty("sms_reply_mode");
  });
});

describe("setContactSmsReplyMode", () => {
  // Like linkCustomerEmail, this makes up to three from() calls (alias-aware
  // UPDATE, INSERT fallback, race-recovery UPDATE) — sequence the terminators.
  function makeSeqClient(terminators: Array<{ data?: unknown; error?: unknown }>) {
    const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
    let i = 0;
    const client = {
      from(table: string) {
        const terminator = terminators[i++] ?? { data: null, error: null };
        const { builder, calls } = makeBuilder(terminator);
        fromCalls.push({ table, calls });
        return builder;
      }
    } as unknown as Parameters<typeof setContactSmsReplyMode>[3];
    return { client, fromCalls };
  }

  it("updates the existing row alias-aware and stops when a row matched", async () => {
    const { client, fromCalls } = makeSeqClient([{ data: [{ id: "row-1" }], error: null }]);
    await setContactSmsReplyMode(BIZ, CUSTOMER, "forward_owner", client);
    expect(fromCalls).toHaveLength(1);
    const upd = fromCalls[0]!;
    expect(upd.table).toBe("contacts");
    expect(upd.calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      sms_reply_mode: "forward_owner"
    });
    expect(upd.calls.find((c) => c.name === "or")?.args[0]).toBe(
      `customer_e164.eq.${CUSTOMER},alias_e164s.cs.{${CUSTOMER}}`
    );
  });

  it("creates a minimal contact row when none exists (thread-history-only numbers)", async () => {
    // PostgREST can hand back `null` instead of `[]` for a zero-row
    // update+select — both must fall through to the insert.
    const { client, fromCalls } = makeSeqClient([
      { data: null, error: null },
      { data: null, error: null }
    ]);
    await setContactSmsReplyMode(BIZ, CUSTOMER, "suppress", client);
    expect(fromCalls).toHaveLength(2);
    const ins = fromCalls[1]!.calls.find((c) => c.name === "insert")?.args[0] as Record<
      string,
      unknown
    >;
    expect(ins).toMatchObject({
      business_id: BIZ,
      customer_e164: CUSTOMER,
      sms_reply_mode: "suppress"
    });
  });

  it("on insert unique-violation, applies the mode to the racing row", async () => {
    const { client, fromCalls } = makeSeqClient([
      { data: [], error: null },
      { data: null, error: { code: "23505", message: "duplicate key" } },
      { data: null, error: null }
    ]);
    await setContactSmsReplyMode(BIZ, CUSTOMER, "suppress", client);
    expect(fromCalls).toHaveLength(3);
    expect(fromCalls[2]!.calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      sms_reply_mode: "suppress"
    });
  });

  it("throws on update / non-unique insert / recovery errors", async () => {
    const updErr = makeSeqClient([{ data: null, error: { message: "upd boom" } }]);
    await expect(setContactSmsReplyMode(BIZ, CUSTOMER, "auto", updErr.client)).rejects.toThrow(
      /setContactSmsReplyMode: upd boom/
    );

    const insErr = makeSeqClient([
      { data: [], error: null },
      { data: null, error: { code: "42501", message: "ins boom" } }
    ]);
    await expect(setContactSmsReplyMode(BIZ, CUSTOMER, "auto", insErr.client)).rejects.toThrow(
      /setContactSmsReplyMode: ins boom/
    );

    const raceErr = makeSeqClient([
      { data: [], error: null },
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: { message: "race boom" } }
    ]);
    await expect(setContactSmsReplyMode(BIZ, CUSTOMER, "auto", raceErr.client)).rejects.toThrow(
      /setContactSmsReplyMode: race boom/
    );
  });

  it("falls back to the default service client when none is provided", async () => {
    const { client } = makeSeqClient([{ data: [{ id: "row-1" }], error: null }]);
    defaultClientSpy.mockReturnValue(client);
    await setContactSmsReplyMode(BIZ, CUSTOMER, "auto");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
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
    assistant_reply_text: string | null;
    rowboat_reply_cached: string | null;
    created_at: string;
  }> = {}) {
    return {
      id: "j-1",
      payload: { data: { payload: { text: "hi" } } },
      assistant_reply_text: null,
      rowboat_reply_cached: "hello",
      created_at: "2026-05-01T00:00:00Z",
      ...overrides
    };
  }

  it("queries sms_inbound_jobs scoped to business_id + customer numbers ordered desc, limit clamped", async () => {
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
    expect(fr.calls.find((c) => c.name === "in")?.args).toEqual([
      "customer_e164",
      [CUSTOMER]
    ]);
  });

  it("includes merged-away aliases in the customer_e164 IN list so a merged profile reads as one thread", async () => {
    const { client, fromCalls } = makeClient({ fromTerminator: { data: [], error: null } });
    await listSmsHistoryForCustomer(
      BIZ,
      CUSTOMER,
      { aliases: ["+15555550999", "+15555550888"] },
      client
    );
    expect(fromCalls[0]?.calls.find((c) => c.name === "in")?.args).toEqual([
      "customer_e164",
      [CUSTOMER, "+15555550999", "+15555550888"]
    ]);
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
      },
      tableTerminators: { sms_outbound_log: { data: [], error: null } }
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
      },
      tableTerminators: { sms_outbound_log: { data: [], error: null } }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    // Note: result is reversed (chronological), so DB index 0 -> result last.
    expect(result.find((r) => r.jobId === "a")?.inboundText).toBe("from text key");
    expect(result.find((r) => r.jobId === "b")?.inboundText).toBe("from body key");
    expect(result.find((r) => r.jobId === "c")?.inboundText).toBe("");
  });

  it("extracts RCS inbound text nested under a body OBJECT (typed text + tapped suggestion)", async () => {
    // RCS webhooks nest content: body.text for typed messages,
    // body.suggestion_response.text for tapped suggested replies. Without
    // this, an RCS-only customer read as having no customer-authored
    // content and the summarizer's gate skipped them (Bugbot, PR #380).
    const { client } = makeClient({
      fromTerminator: {
        data: [
          jobRow({ id: "typed", payload: { data: { payload: { body: { text: "rcs typed" } } } } }),
          jobRow({
            id: "tapped",
            payload: {
              data: { payload: { body: { suggestion_response: { text: "rcs tapped" } } } }
            }
          }),
          // body object with neither shape → degrade to empty, never throw.
          jobRow({ id: "odd", payload: { data: { payload: { body: { media: ["x"] } } } } }),
          // suggestion_response present but its text is not a string.
          jobRow({
            id: "oddSuggestion",
            payload: { data: { payload: { body: { suggestion_response: { text: 42 } } } } }
          }),
          // body is an ARRAY (not a text-bearing object) → empty.
          jobRow({ id: "arr", payload: { data: { payload: { body: ["not", "text"] } } } })
        ],
        error: null
      },
      tableTerminators: { sms_outbound_log: { data: [], error: null } }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result.find((r) => r.jobId === "typed")?.inboundText).toBe("rcs typed");
    expect(result.find((r) => r.jobId === "tapped")?.inboundText).toBe("rcs tapped");
    expect(result.find((r) => r.jobId === "odd")?.inboundText).toBe("");
    expect(result.find((r) => r.jobId === "oddSuggestion")?.inboundText).toBe("");
    expect(result.find((r) => r.jobId === "arr")?.inboundText).toBe("");
  });

  it("prefers the durable assistant_reply_text over the transient cache, and falls back when it's blank", async () => {
    const { client } = makeClient({
      fromTerminator: {
        data: [
          // Durable copy present → used even when the retry cache was cleared.
          jobRow({ id: "durable", assistant_reply_text: "durable reply", rowboat_reply_cached: null }),
          // Durable present AND a stale cache → durable still wins.
          jobRow({ id: "both", assistant_reply_text: "durable wins", rowboat_reply_cached: "stale" }),
          // Durable is whitespace-only → treated as empty, falls back to cache.
          jobRow({ id: "blank", assistant_reply_text: "   ", rowboat_reply_cached: "cache fallback" })
        ],
        error: null
      },
      tableTerminators: { sms_outbound_log: { data: [], error: null } }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result.find((r) => r.jobId === "durable")?.assistantReply).toBe("durable reply");
    expect(result.find((r) => r.jobId === "both")?.assistantReply).toBe("durable wins");
    expect(result.find((r) => r.jobId === "blank")?.assistantReply).toBe("cache fallback");
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
      },
      tableTerminators: { sms_outbound_log: { data: [], error: null } }
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

  it("also queries sms_outbound_log scoped to business + to_e164 numbers (aliases included)", async () => {
    const { client, fromCalls } = makeClient({
      fromTerminator: { data: [], error: null }
    });
    await listSmsHistoryForCustomer(BIZ, CUSTOMER, { aliases: ["+15555550999"] }, client);
    const out = fromCalls.find((f) => f.table === "sms_outbound_log");
    expect(out).toBeDefined();
    expect(out!.calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(out!.calls.find((c) => c.name === "in")?.args).toEqual([
      "to_e164",
      [CUSTOMER, "+15555550999"]
    ]);
  });

  it("merges worker-initiated sends chronologically with inbound jobs, tagging their source", async () => {
    // AiFlow texted the lead FIRST (no inbound job exists for that send) —
    // exactly the live shape that left the profile page saying "No SMS
    // history" while the thread page showed the message.
    const { client } = makeClient({
      tableTerminators: {
        sms_inbound_jobs: {
          data: [jobRow({ id: "reply", created_at: "2026-05-02T00:00:00Z" })],
          error: null
        },
        sms_outbound_log: {
          data: [
            {
              id: "intro",
              body: "Hi Liz, re your inquiry...",
              source: "ai_flow",
              created_at: "2026-05-01T00:00:00Z"
            }
          ],
          error: null
        }
      }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result.map((r) => r.jobId)).toEqual(["intro", "reply"]);
    const intro = result[0]!;
    expect(intro.inboundText).toBe("");
    expect(intro.assistantReply).toBe("Hi Liz, re your inquiry...");
    expect(intro.source).toBe("ai_flow");
    expect(result[1]!.source).toBeUndefined();
  });

  it("returns ONLY outbound-log sends when no inbound job exists at all", async () => {
    const { client } = makeClient({
      tableTerminators: {
        sms_inbound_jobs: { data: [], error: null },
        sms_outbound_log: {
          data: [
            { id: "o1", body: "intro", source: "ai_flow", created_at: "2026-05-01T00:00:00Z" }
          ],
          error: null
        }
      }
    });
    const result = await listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client);
    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("o1");
  });

  it("propagates sms_outbound_log errors", async () => {
    const { client } = makeClient({
      tableTerminators: {
        sms_inbound_jobs: { data: [], error: null },
        sms_outbound_log: { data: null, error: { message: "outbound rls" } }
      }
    });
    await expect(listSmsHistoryForCustomer(BIZ, CUSTOMER, {}, client)).rejects.toThrow(
      /listSmsHistoryForCustomer: outbound rls/
    );
  });
});

describe("default service-client fallback (every public helper)", () => {
  // Each helper exposes an optional `client` arg purely so the unit
  // tests above can swap in a stub. In production every caller goes
  // through the `client ?? (await createSupabaseServiceClient())`
  // branch — exercise it explicitly to keep coverage at 100% AND to
  // notice if any helper accidentally drops the fallback.

  it("getCustomerMemory falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    defaultClientSpy.mockReturnValue(client);
    await getCustomerMemory(BIZ, CUSTOMER);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("listCustomerMemories falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: [], error: null } });
    defaultClientSpy.mockReturnValue(client);
    await listCustomerMemories(BIZ);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("recordInteractionAndIncrement falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ rpcResult: { data: memory(), error: null } });
    defaultClientSpy.mockReturnValue(client);
    await recordInteractionAndIncrement(BIZ, CUSTOMER, "sms", {});
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("updateCustomerSummary falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    defaultClientSpy.mockReturnValue(client);
    await updateCustomerSummary(BIZ, CUSTOMER, { summaryMd: "x", resetCounter: true });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("touchLastSummarizedAt falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    defaultClientSpy.mockReturnValue(client);
    await touchLastSummarizedAt(BIZ, CUSTOMER);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("updateCustomerOwnerFields falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    defaultClientSpy.mockReturnValue(client);
    await updateCustomerOwnerFields(BIZ, CUSTOMER, { displayName: "x" });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("deleteCustomerMemory falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: null, error: null } });
    defaultClientSpy.mockReturnValue(client);
    await deleteCustomerMemory(BIZ, CUSTOMER);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("listSmsHistoryForCustomer falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: [], error: null } });
    defaultClientSpy.mockReturnValue(client);
    await listSmsHistoryForCustomer(BIZ, CUSTOMER);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("mergeCustomerMemories falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ rpcResult: { data: memory(), error: null } });
    defaultClientSpy.mockReturnValue(client);
    await mergeCustomerMemories(BIZ, "+15555550777", CUSTOMER);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("createCustomerMemory falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: memory(), error: null } });
    defaultClientSpy.mockReturnValue(client);
    await createCustomerMemory(BIZ, { customerE164: CUSTOMER });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("findCustomerByEmail falls back to createSupabaseServiceClient", async () => {
    const { client } = makeClient({ fromTerminator: { data: [], error: null } });
    defaultClientSpy.mockReturnValue(client);
    await findCustomerByEmail(BIZ, "joe@x.com");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
