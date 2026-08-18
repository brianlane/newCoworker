/**
 * src/lib/mcp/connector-status.ts, the per (user, MCP client, business)
 * "first/last authorized call" bookkeeping behind each connector card's
 * Connected state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  deleteMcpConnectorStatus,
  getMcpConnectorStatusForBusiness,
  hasMcpConnectorRow,
  isMcpConnectorStale,
  recordMcpConnectorSeen,
  MCP_SEEN_DEBOUNCE_MS,
  MCP_STALE_MS
} from "@/lib/mcp/connector-status";
import { logger } from "@/lib/logger";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUSINESS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = Date.parse("2026-07-20T02:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

type Result = { data: unknown; error: { message: string } | null };
type Filter = [string, unknown];

/**
 * Stands in for the PostgREST builder across all three shapes this module
 * uses: the single-row read behind the debounce (`.maybeSingle()`), the
 * business read (`.order().limit()`), and the delete (`.select()`).
 *
 * Every filter is recorded so a test can assert which rows a query would
 * actually have touched. That matters more than usual here: the whole bug
 * this file guards was a query missing a scope, and both the update losing
 * its client filter and the read losing its business filter look identical
 * from the outside until you look at the filters.
 */
function makeDb(
  opts: {
    read?: Result;
    list?: Result;
    del?: Result;
    insertError?: { message: string; code?: string } | null;
    updateError?: { message: string } | null;
  } = {}
) {
  const read = opts.read ?? { data: null, error: null };
  const list = opts.list ?? { data: [], error: null };
  const del = opts.del ?? { data: [], error: null };

  const selectFilters: Filter[] = [];
  const selectChain: Record<string, unknown> = {
    maybeSingle: vi.fn().mockResolvedValue(read),
    order: vi.fn(() => selectChain),
    limit: vi.fn().mockResolvedValue(list)
  };
  selectChain.eq = vi.fn((column: string, value: unknown) => {
    selectFilters.push([column, value]);
    return selectChain;
  });
  const select = vi.fn(() => selectChain);

  const insert = vi.fn().mockResolvedValue({ error: opts.insertError ?? null });

  const updateFilters: Filter[] = [];
  const updateResult = { error: opts.updateError ?? null };
  const updateChain: Record<string, unknown> = {
    // The builder is thenable, so awaiting the last .eq() resolves it.
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(updateResult).then(resolve, reject)
  };
  updateChain.eq = vi.fn((column: string, value: unknown) => {
    updateFilters.push([column, value]);
    return updateChain;
  });
  const update = vi.fn(() => updateChain);

  const deleteFilters: Filter[] = [];
  const deleteChain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue(del)
  };
  deleteChain.eq = vi.fn((column: string, value: unknown) => {
    deleteFilters.push([column, value]);
    return deleteChain;
  });
  const del_ = vi.fn(() => deleteChain);

  const db = {
    from: vi.fn(() => ({ select, insert, update, delete: del_ }))
  };
  return {
    db: db as never,
    insert,
    update,
    selectChain,
    selectFilters,
    updateFilters,
    deleteFilters
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isMcpConnectorStale", () => {
  it("is false right up to the threshold and true at it", () => {
    const justInside = new Date(NOW - MCP_STALE_MS + 1000).toISOString();
    const exactly = new Date(NOW - MCP_STALE_MS).toISOString();
    expect(isMcpConnectorStale(justInside, NOW)).toBe(false);
    expect(isMcpConnectorStale(exactly, NOW)).toBe(true);
  });

  it("treats an unparseable timestamp as fresh, never nagging a working tenant", () => {
    expect(isMcpConnectorStale("not-a-date", NOW)).toBe(false);
  });

  it("uses the real clock by default", () => {
    expect(isMcpConnectorStale(new Date().toISOString())).toBe(false);
  });
});

describe("getMcpConnectorStatusForBusiness", () => {
  it("returns the most recent row for the business", async () => {
    const { db } = makeDb({
      list: {
        data: [
          {
            user_id: USER,
            first_connected_at: "2026-07-01T00:00:00Z",
            last_seen_at: "2026-07-19T00:00:00Z"
          }
        ],
        error: null
      }
    });
    expect(await getMcpConnectorStatusForBusiness(BUSINESS, "claude", db)).toEqual({
      firstConnectedAt: "2026-07-01T00:00:00Z",
      lastSeenAt: "2026-07-19T00:00:00Z",
      userId: USER
    });
  });

  /**
   * Regression guard for the reported bug: the read was keyed on the SIGNED-IN
   * USER, so an admin using view-as saw their own connector on every tenant's
   * tile. It must filter on the business and the client, and nothing else.
   */
  it("filters on business and client, never on a user", async () => {
    const { db, selectFilters, selectChain } = makeDb();
    await getMcpConnectorStatusForBusiness(BUSINESS, "chatgpt", db);
    expect(selectFilters).toEqual([
      ["business_id", BUSINESS],
      ["client", "chatgpt"]
    ]);
    expect(selectChain.limit).toHaveBeenCalledWith(1);
    expect(selectChain.order).toHaveBeenCalledWith("last_seen_at", { ascending: false });
  });

  it("returns null for a business no assistant has acted on", async () => {
    const { db } = makeDb({ list: { data: [], error: null } });
    expect(await getMcpConnectorStatusForBusiness(BUSINESS, "claude", db)).toBeNull();
  });

  it("returns null when PostgREST answers with no data at all", async () => {
    const { db } = makeDb({ list: { data: null, error: null } });
    expect(await getMcpConnectorStatusForBusiness(BUSINESS, "claude", db)).toBeNull();
  });

  it("throws on a read error", async () => {
    const { db } = makeDb({ list: { data: null, error: { message: "boom" } } });
    await expect(getMcpConnectorStatusForBusiness(BUSINESS, "claude", db)).rejects.toThrow(
      "getMcpConnectorStatusForBusiness: boom"
    );
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb();
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await getMcpConnectorStatusForBusiness(BUSINESS, "claude")).toBeNull();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("recordMcpConnectorSeen", () => {
  it("inserts first_connected_at + last_seen_at on the first call", async () => {
    const { db, insert } = makeDb();
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(insert).toHaveBeenCalledWith({
      user_id: USER,
      client: "claude",
      business_id: BUSINESS,
      first_connected_at: NOW_ISO,
      last_seen_at: NOW_ISO
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("gives each client its own row, so one connector cannot light the other", async () => {
    const { db, insert } = makeDb();
    await recordMcpConnectorSeen(USER, "chatgpt", BUSINESS, db, NOW);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ client: "chatgpt" }));
  });

  it("looks up the row by all three key parts", async () => {
    const { db, selectFilters } = makeDb();
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(selectFilters).toEqual([
      ["user_id", USER],
      ["client", "claude"],
      ["business_id", BUSINESS]
    ]);
  });

  it("tolerates a concurrent-first-request unique violation", async () => {
    const { db } = makeDb({ insertError: { message: "dup", code: "23505" } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns (never throws) on a non-unique insert error", async () => {
    const { db } = makeDb({ insertError: { message: "denied", code: "42501" } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({
        userId: USER,
        client: "claude",
        businessId: BUSINESS,
        error: "denied"
      })
    );
  });

  it("skips the write inside the debounce window (reads stay the common case)", async () => {
    const fresh = new Date(NOW - MCP_SEEN_DEBOUNCE_MS + 1000).toISOString();
    const { db, update, insert } = makeDb({ read: { data: { last_seen_at: fresh }, error: null } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("refreshes last_seen_at once the debounce window has passed", async () => {
    const stale = new Date(NOW - MCP_SEEN_DEBOUNCE_MS - 1000).toISOString();
    const { db, update } = makeDb({ read: { data: { last_seen_at: stale }, error: null } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(update).toHaveBeenCalledWith({ last_seen_at: NOW_ISO });
  });

  /**
   * Regression guard. The debounced update filtered on `user_id` alone, which
   * was correct while one row existed per user and silently wrong the moment
   * a second client (and now a second business) appears: one assistant's
   * traffic would stamp every connector card the user has as recently used.
   */
  it("refreshes only the client and business that made the call", async () => {
    const stale = new Date(NOW - MCP_SEEN_DEBOUNCE_MS - 1000).toISOString();
    const { db, updateFilters } = makeDb({ read: { data: { last_seen_at: stale }, error: null } });
    await recordMcpConnectorSeen(USER, "chatgpt", BUSINESS, db, NOW);
    expect(updateFilters).toEqual([
      ["user_id", USER],
      ["client", "chatgpt"],
      ["business_id", BUSINESS]
    ]);
  });

  it("treats an unparseable last_seen_at as stale (refreshes)", async () => {
    const { db, update } = makeDb({ read: { data: { last_seen_at: "not-a-date" }, error: null } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(update).toHaveBeenCalledWith({ last_seen_at: NOW_ISO });
  });

  it("warns (never throws) on read / update errors, Error and non-Error shapes", async () => {
    const { db } = makeDb({ read: { data: null, error: { message: "read down" } } });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "read down" })
    );

    const stale = new Date(NOW - MCP_SEEN_DEBOUNCE_MS - 1000).toISOString();
    const { db: db2 } = makeDb({
      read: { data: { last_seen_at: stale }, error: null },
      updateError: { message: "update down" }
    });
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, db2, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "update down" })
    );

    // Non-Error rejection shape (client construction failing with a string).
    createSupabaseServiceClient.mockRejectedValueOnce("client boom");
    await recordMcpConnectorSeen(USER, "claude", BUSINESS, undefined, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "client boom" })
    );
  });

  it("creates a service client when none is provided and uses the real clock by default", async () => {
    const { db, insert } = makeDb();
    createSupabaseServiceClient.mockResolvedValue(db);
    const before = Date.now();
    await recordMcpConnectorSeen(USER, "claude", BUSINESS);
    const after = Date.now();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    const stamped = Date.parse(insert.mock.calls[0][0].last_seen_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe("hasMcpConnectorRow", () => {
  /**
   * The Disconnect button's guard against revoking the wrong login's OAuth
   * grant, so it has to be keyed on all three parts. A check that ignored the
   * business would let an admin using view-as revoke their own Claude access
   * while clearing a tenant's card.
   */
  it("asks about this login, this business, and this client", async () => {
    const { db, selectFilters } = makeDb({ read: { data: { user_id: USER }, error: null } });
    expect(await hasMcpConnectorRow(USER, BUSINESS, "chatgpt", db)).toBe(true);
    expect(selectFilters).toEqual([
      ["user_id", USER],
      ["business_id", BUSINESS],
      ["client", "chatgpt"]
    ]);
  });

  it("is false when this login has no row here", async () => {
    const { db } = makeDb({ read: { data: null, error: null } });
    expect(await hasMcpConnectorRow(USER, BUSINESS, "claude", db)).toBe(false);
  });

  it("throws on a read error rather than guessing", async () => {
    const { db } = makeDb({ read: { data: null, error: { message: "boom" } } });
    await expect(hasMcpConnectorRow(USER, BUSINESS, "claude", db)).rejects.toThrow(
      "hasMcpConnectorRow: boom"
    );
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({ read: { data: null, error: null } });
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await hasMcpConnectorRow(USER, BUSINESS, "claude")).toBe(false);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("deleteMcpConnectorStatus", () => {
  it("clears every login's row for that business and client, and counts them", async () => {
    const { db, deleteFilters } = makeDb({
      del: { data: [{ user_id: USER }, { user_id: OTHER_USER }], error: null }
    });
    expect(await deleteMcpConnectorStatus(BUSINESS, "claude", db)).toBe(2);
    expect(deleteFilters).toEqual([
      ["business_id", BUSINESS],
      ["client", "claude"]
    ]);
  });

  /**
   * A PostgREST delete matching nothing succeeds silently, so the count is the
   * only way the route can tell "cleared it" from "there was nothing there".
   */
  it("reports zero when nothing matched", async () => {
    const { db } = makeDb({ del: { data: [], error: null } });
    expect(await deleteMcpConnectorStatus(BUSINESS, "chatgpt", db)).toBe(0);
  });

  it("reports zero when PostgREST returns no data", async () => {
    const { db } = makeDb({ del: { data: null, error: null } });
    expect(await deleteMcpConnectorStatus(BUSINESS, "chatgpt", db)).toBe(0);
  });

  it("throws on a delete error", async () => {
    const { db } = makeDb({ del: { data: null, error: { message: "nope" } } });
    await expect(deleteMcpConnectorStatus(BUSINESS, "claude", db)).rejects.toThrow(
      "deleteMcpConnectorStatus: nope"
    );
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({ del: { data: [], error: null } });
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await deleteMcpConnectorStatus(BUSINESS, "claude")).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
