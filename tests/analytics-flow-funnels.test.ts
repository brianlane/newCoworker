import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return {
    ...actual,
    isVpsReadMode: vi.fn(async () => false),
    readMovedRows: vi.fn(async () => [])
  };
});

import {
  FLOW_FUNNEL_CANDIDATE_LIMIT,
  FLOW_FUNNEL_FLOW_LIMIT,
  FLOW_FUNNEL_SCAN_LIMIT,
  getFlowFunnels,
  runReachedGoal
} from "@/lib/analytics/flow-funnels";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NOW = new Date("2026-07-04T12:00:00Z");

type QueryResult = { data?: unknown; error: { message: string } | null };

function makeClient(resultsByTable: Record<string, QueryResult>) {
  const chains: Record<string, unknown> = {};
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "gte", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (onF: (v: QueryResult) => unknown) =>
      Promise.resolve(resultsByTable[table] ?? { data: [], error: null }).then(onF);
    chains[table] = chain;
    return chain;
  });
  return { client: { from } as never, chains };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVpsReadMode).mockResolvedValue(false);
  vi.mocked(readMovedRows).mockResolvedValue([]);
});

describe("runReachedGoal", () => {
  it("detects the __goal_ marker and rejects junk-shaped vars", () => {
    expect(runReachedGoal({ vars: { __goal_step1: "replied" } })).toBe(true);
    expect(runReachedGoal({ vars: { lead_name: "Amy" } })).toBe(false);
    expect(runReachedGoal({ vars: [] })).toBe(false);
    expect(runReachedGoal({ vars: "junk" })).toBe(false);
    expect(runReachedGoal({})).toBe(false);
    expect(runReachedGoal(null)).toBe(false);
  });
});

describe("getFlowFunnels", () => {
  it("aggregates runs, texts, clicks, and goals per flow, busiest first", async () => {
    const { client, chains } = makeClient({
      ai_flows: {
        data: [
          { id: "flow-idle", name: "Idle flow", enabled: false },
          { id: "flow-busy", name: "Lead follow-up", enabled: true }
        ],
        error: null
      },
      ai_flow_runs: {
        data: [
          { flow_id: "flow-busy", context: { vars: { __goal_g1: "replied" } } },
          { flow_id: "flow-busy", context: { vars: {} } },
          { flow_id: "flow-busy", context: null },
          // Run for a flow beyond the flow list (deleted flow) — ignored in rows.
          { flow_id: "flow-gone", context: { vars: { __goal_g1: "claimed" } } }
        ],
        error: null
      },
      sms_outbound_log: {
        data: [{ flow_id: "flow-busy" }, { flow_id: "flow-busy" }],
        error: null
      },
      sms_links: {
        data: [
          { flow_id: "flow-busy", click_count: 3 },
          { flow_id: "flow-busy", click_count: 0 },
          { flow_id: "flow-busy", click_count: 1 }
        ],
        error: null
      }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW, days: 30 });
    expect(funnels.clipped).toBe(false);
    expect(funnels.rows).toEqual([
      {
        flowId: "flow-busy",
        flowName: "Lead follow-up",
        enabled: true,
        runs: 3,
        textsSent: 2,
        linksClicked: 2,
        linkClicks: 4,
        goalsReached: 1
      },
      {
        flowId: "flow-idle",
        flowName: "Idle flow",
        enabled: false,
        runs: 0,
        textsSent: 0,
        linksClicked: 0,
        linkClicks: 0,
        goalsReached: 0
      }
    ]);
    const flows = chains.ai_flows as { limit: ReturnType<typeof vi.fn> };
    expect(flows.limit).toHaveBeenCalledWith(FLOW_FUNNEL_CANDIDATE_LIMIT);
    const runsChain = chains.ai_flow_runs as {
      gte: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    // Day-aligned window shared with every other analytics card.
    expect(runsChain.gte).toHaveBeenCalledWith("created_at", "2026-06-05T00:00:00.000Z");
    expect(runsChain.limit).toHaveBeenCalledWith(FLOW_FUNNEL_SCAN_LIMIT);
    const links = chains.sms_links as { not: ReturnType<typeof vi.fn> };
    expect(links.not).toHaveBeenCalledWith("flow_id", "is", null);
  });

  it("ranks by run count across MANY flows (an old busy flow beats new idle ones) and caps the list", async () => {
    const flows = Array.from({ length: FLOW_FUNNEL_FLOW_LIMIT + 10 }, (_, i) => ({
      // Newest first, like the query returns; the OLDEST one is the busy one.
      id: `flow-${i}`,
      name: `Flow ${i}`,
      enabled: true
    }));
    const busyId = `flow-${FLOW_FUNNEL_FLOW_LIMIT + 9}`; // last = oldest
    const { client } = makeClient({
      ai_flows: { data: flows, error: null },
      ai_flow_runs: { data: [{ flow_id: busyId, context: null }], error: null },
      sms_outbound_log: { data: [], error: null },
      sms_links: { data: [], error: null }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW });
    expect(funnels.rows).toHaveLength(FLOW_FUNNEL_FLOW_LIMIT);
    expect(funnels.rows[0].flowId).toBe(busyId);
  });

  it("a full flow-candidate list alone does NOT flag clipping (counts stay accurate)", async () => {
    const manyFlows = Array.from({ length: FLOW_FUNNEL_CANDIDATE_LIMIT }, (_, i) => ({
      id: `flow-${i}`,
      name: `Flow ${i}`,
      enabled: true
    }));
    const { client } = makeClient({
      ai_flows: { data: manyFlows, error: null },
      ai_flow_runs: { data: [], error: null },
      sms_outbound_log: { data: [], error: null },
      sms_links: { data: [], error: null }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW });
    expect(funnels.clipped).toBe(false);
  });

  it("vps sends clipping is judged on RAW scanned rows, before null flow_ids drop", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockImplementation(async (_biz: string, req: { table: string }) => {
      if (req.table === "ai_flows") {
        return [{ id: "flow-1", name: "F", enabled: true }] as never;
      }
      // A FULL raw page whose rows are mostly unattributed: the filtered
      // list is tiny, but the scan itself was capped — must flag clipped.
      return Array.from({ length: FLOW_FUNNEL_SCAN_LIMIT }, (_, i) => ({
        flow_id: i === 0 ? "flow-1" : null
      })) as never;
    });
    const { client } = makeClient({
      ai_flow_runs: { data: [], error: null },
      sms_links: { data: [], error: null }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW });
    expect(funnels.clipped).toBe(true);
    expect(funnels.rows[0].textsSent).toBe(1);
  });

  it("flags clipping when any source scan fills its cap", async () => {
    const fullRuns = Array.from({ length: FLOW_FUNNEL_SCAN_LIMIT }, () => ({
      flow_id: "flow-1",
      context: null
    }));
    const { client } = makeClient({
      ai_flows: { data: [{ id: "flow-1", name: "F", enabled: true }], error: null },
      ai_flow_runs: { data: fullRuns, error: null },
      sms_outbound_log: { data: [], error: null },
      sms_links: { data: [], error: null }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW });
    expect(funnels.clipped).toBe(true);
  });

  it("routes ai_flows and sms_outbound_log through the box for vps-mode tenants", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(true);
    vi.mocked(readMovedRows).mockImplementation(async (_biz: string, req: { table: string }) => {
      if (req.table === "ai_flows") {
        return [{ id: "flow-1", name: "Boxed flow", enabled: true }] as never;
      }
      // Box sends include a null flow_id (no "is not null" in the data-api
      // grammar) — filtered client-side.
      return [{ flow_id: "flow-1" }, { flow_id: null }] as never;
    });
    const { client, chains } = makeClient({
      ai_flow_runs: { data: [{ flow_id: "flow-1", context: null }], error: null },
      sms_links: { data: [], error: null }
    });
    const funnels = await getFlowFunnels("biz-1", { client, now: NOW });
    expect(funnels.rows).toEqual([
      {
        flowId: "flow-1",
        flowName: "Boxed flow",
        enabled: true,
        runs: 1,
        textsSent: 1,
        linksClicked: 0,
        linkClicks: 0,
        goalsReached: 0
      }
    ]);
    // Central reads happened only for the engine/central tables.
    expect(chains.ai_flows).toBeUndefined();
    expect(chains.sms_outbound_log).toBeUndefined();
    expect(vi.mocked(readMovedRows)).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ table: "ai_flows" })
    );
    expect(vi.mocked(readMovedRows)).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ table: "sms_outbound_log" })
    );
  });

  it("handles null pages and defaults client/now/days", async () => {
    const { client } = makeClient({
      ai_flows: { data: null, error: null },
      ai_flow_runs: { data: null, error: null },
      sms_outbound_log: { data: null, error: null },
      sms_links: { data: null, error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    expect(await getFlowFunnels("biz-1")).toEqual({ rows: [], clipped: false });
  });

  it.each([
    ["ai_flows", /getFlowFunnels flows: boom/],
    ["ai_flow_runs", /getFlowFunnels runs: boom/],
    ["sms_outbound_log", /getFlowFunnels sends: boom/],
    ["sms_links", /getFlowFunnels links: boom/]
  ] as Array<[string, RegExp]>)("throws on a %s query error", async (table, pattern) => {
    const { client } = makeClient({ [table]: { data: null, error: { message: "boom" } } });
    await expect(getFlowFunnels("biz-1", { client, now: NOW })).rejects.toThrow(pattern);
  });
});
