import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  FLOW_FUNNEL_FLOW_LIMIT,
  FLOW_FUNNEL_SCAN_LIMIT,
  getFlowFunnels,
  runReachedGoal
} from "@/lib/analytics/flow-funnels";
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
  it("aggregates runs, texts, clicks, and goals per flow, most-run first", async () => {
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
    const rows = await getFlowFunnels("biz-1", { client, now: NOW, days: 30 });
    expect(rows).toEqual([
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
    expect(flows.limit).toHaveBeenCalledWith(FLOW_FUNNEL_FLOW_LIMIT);
    const runsChain = chains.ai_flow_runs as {
      gte: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(runsChain.gte).toHaveBeenCalledWith(
      "created_at",
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );
    expect(runsChain.limit).toHaveBeenCalledWith(FLOW_FUNNEL_SCAN_LIMIT);
    const links = chains.sms_links as { not: ReturnType<typeof vi.fn> };
    expect(links.not).toHaveBeenCalledWith("flow_id", "is", null);
  });

  it("handles null pages and defaults client/now/days", async () => {
    const { client } = makeClient({
      ai_flows: { data: null, error: null },
      ai_flow_runs: { data: null, error: null },
      sms_outbound_log: { data: null, error: null },
      sms_links: { data: null, error: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    expect(await getFlowFunnels("biz-1")).toEqual([]);
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
