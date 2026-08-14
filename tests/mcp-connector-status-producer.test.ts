/**
 * The connector-status row, asserted at the PRODUCER.
 *
 * Every other test in this area hand-feeds the stamp: they mock
 * `requireMcpBusinessRole` (so the write never runs) or call
 * `recordMcpConnectorSeen` directly (so the arguments are the test's, not the
 * product's). Neither proves that a real tool call actually writes a real row
 * with the business on it, and "the write exists but nobody calls it" is
 * exactly how this feature broke the first time.
 *
 * So this drives a genuine tool handler end to end with the REAL auth module
 * and the REAL connector-status module, mocking only the database and the
 * team-role lookup, and asserts the insert that reaches PostgREST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/business-members", () => ({
  getBusinessRoleForEmail: vi.fn()
}));
vi.mock("@/lib/dashboard/active-business", () => ({
  listAccessibleBusinesses: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

const serviceClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: serviceClient
}));

import { getBusinessTool } from "@/lib/mcp/tools/read";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { runTool } from "./helpers/run-mcp-tool";

const BUSINESS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTH = { userId: "user-1", email: "owner@biz.com", client: "chatgpt" as const };

const BUSINESS_ROW = {
  id: BUSINESS,
  name: "Scar Fairy",
  tier: "standard",
  status: "active",
  timezone: "America/Los_Angeles",
  created_at: "2026-01-01T00:00:00Z"
};

/**
 * One fake serving both tables the call touches: the tool's own read of
 * `businesses`, and the status write to `mcp_connector_status`.
 */
function makeDb() {
  const inserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    if (table === "mcp_connector_status") {
      const chain: Record<string, unknown> = {
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
      };
      chain.eq = vi.fn(() => chain);
      return {
        select: vi.fn(() => chain),
        insert: vi.fn((row: Record<string, unknown>) => {
          inserts.push(row);
          return Promise.resolve({ error: null });
        })
      };
    }
    const chain: Record<string, unknown> = {
      maybeSingle: vi.fn().mockResolvedValue({ data: BUSINESS_ROW, error: null })
    };
    chain.eq = vi.fn(() => chain);
    return { select: vi.fn(() => chain) };
  });
  return { db: { from }, inserts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a real tool call stamps a real row", () => {
  it("writes user, client, and business when the call is allowed", async () => {
    const { db, inserts } = makeDb();
    serviceClient.mockResolvedValue(db);
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");

    await runTool(getBusinessTool, { business_id: BUSINESS }, AUTH);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      user_id: AUTH.userId,
      client: "chatgpt",
      business_id: BUSINESS
    });
  });

  it("writes nothing when the caller has no role on that business", async () => {
    const { db, inserts } = makeDb();
    serviceClient.mockResolvedValue(db);
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);

    await expect(runTool(getBusinessTool, { business_id: BUSINESS }, AUTH)).rejects.toThrow();
    expect(inserts).toEqual([]);
  });
});
