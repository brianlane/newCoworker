/**
 * src/lib/mcp/connector-status.ts — the Claude connector's per-user
 * "first/last authenticated MCP request" bookkeeping behind the dashboard
 * card's Connected state.
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
  getMcpConnectorStatus,
  recordMcpConnectorSeen,
  MCP_SEEN_DEBOUNCE_MS
} from "@/lib/mcp/connector-status";
import { logger } from "@/lib/logger";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.parse("2026-07-20T02:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

type ReadRow = { data: unknown; error: { message: string } | null };

function makeDb(
  read: ReadRow,
  opts: {
    insertError?: { message: string; code?: string } | null;
    updateError?: { message: string } | null;
  } = {}
) {
  const maybeSingle = vi.fn().mockResolvedValue(read);
  const insert = vi.fn().mockResolvedValue({ error: opts.insertError ?? null });
  const updateEq = vi.fn().mockResolvedValue({ error: opts.updateError ?? null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle }))
      })),
      insert,
      update
    }))
  };
  return { db: db as never, insert, update, updateEq };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMcpConnectorStatus", () => {
  it("returns the stored row", async () => {
    const { db } = makeDb({
      data: { first_connected_at: "2026-07-01T00:00:00Z", last_seen_at: "2026-07-19T00:00:00Z" },
      error: null
    });
    expect(await getMcpConnectorStatus(USER, db)).toEqual({
      firstConnectedAt: "2026-07-01T00:00:00Z",
      lastSeenAt: "2026-07-19T00:00:00Z"
    });
  });

  it("returns null for a never-connected user", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await getMcpConnectorStatus(USER, db)).toBeNull();
  });

  it("throws on a read error", async () => {
    const { db } = makeDb({ data: null, error: { message: "boom" } });
    await expect(getMcpConnectorStatus(USER, db)).rejects.toThrow(
      "getMcpConnectorStatus: boom"
    );
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({ data: null, error: null });
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await getMcpConnectorStatus(USER)).toBeNull();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("recordMcpConnectorSeen", () => {
  it("inserts first_connected_at + last_seen_at on the first request", async () => {
    const { db, insert } = makeDb({ data: null, error: null });
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(insert).toHaveBeenCalledWith({
      user_id: USER,
      first_connected_at: NOW_ISO,
      last_seen_at: NOW_ISO
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("tolerates a concurrent-first-request unique violation", async () => {
    const { db } = makeDb(
      { data: null, error: null },
      { insertError: { message: "dup", code: "23505" } }
    );
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns (never throws) on a non-unique insert error", async () => {
    const { db } = makeDb(
      { data: null, error: null },
      { insertError: { message: "denied", code: "42501" } }
    );
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ userId: USER, error: "denied" })
    );
  });

  it("skips the write inside the debounce window (reads stay the common case)", async () => {
    const fresh = new Date(NOW - MCP_SEEN_DEBOUNCE_MS + 1000).toISOString();
    const { db, update, insert } = makeDb({ data: { last_seen_at: fresh }, error: null });
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("refreshes last_seen_at once the debounce window has passed", async () => {
    const stale = new Date(NOW - MCP_SEEN_DEBOUNCE_MS - 1000).toISOString();
    const { db, update, updateEq } = makeDb({ data: { last_seen_at: stale }, error: null });
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(update).toHaveBeenCalledWith({ last_seen_at: NOW_ISO });
    expect(updateEq).toHaveBeenCalledWith("user_id", USER);
  });

  it("treats an unparseable last_seen_at as stale (refreshes)", async () => {
    const { db, update } = makeDb({ data: { last_seen_at: "not-a-date" }, error: null });
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(update).toHaveBeenCalledWith({ last_seen_at: NOW_ISO });
  });

  it("warns (never throws) on read / update errors, Error and non-Error shapes", async () => {
    const { db } = makeDb({ data: null, error: { message: "read down" } });
    await recordMcpConnectorSeen(USER, db, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "read down" })
    );

    const stale = new Date(NOW - MCP_SEEN_DEBOUNCE_MS - 1000).toISOString();
    const { db: db2 } = makeDb(
      { data: { last_seen_at: stale }, error: null },
      { updateError: { message: "update down" } }
    );
    await recordMcpConnectorSeen(USER, db2, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "update down" })
    );

    // Non-Error rejection shape (client construction failing with a string).
    createSupabaseServiceClient.mockRejectedValueOnce("client boom");
    await recordMcpConnectorSeen(USER, undefined, NOW);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp connector-status: seen stamp failed",
      expect.objectContaining({ error: "client boom" })
    );
  });

  it("creates a service client when none is provided and uses the real clock by default", async () => {
    const { db, insert } = makeDb({ data: null, error: null });
    createSupabaseServiceClient.mockResolvedValue(db);
    const before = Date.now();
    await recordMcpConnectorSeen(USER);
    const after = Date.now();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    const stamped = Date.parse(insert.mock.calls[0][0].last_seen_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});
