import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildActivityFeed,
  getRecentActivity,
  DEFAULT_ACTIVITY_LIMIT,
  type ActivityFeedInput
} from "@/lib/db/activity";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

function emptyInput(overrides: Partial<ActivityFeedInput> = {}): ActivityFeedInput {
  return {
    calls: [],
    smsInbound: [],
    smsOutbound: [],
    chat: [],
    flows: [],
    customers: [],
    alerts: [],
    limit: 10,
    ...overrides
  };
}

/** Telnyx inbound webhook envelope carrying a customer phone. */
function smsPayload(from: string): Record<string, unknown> {
  return { data: { payload: { from: { phone_number: from } } } };
}

describe("buildActivityFeed", () => {
  it("returns empty feed when every source is empty", () => {
    expect(buildActivityFeed(emptyInput())).toEqual([]);
  });

  it("maps a call with a known caller", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        calls: [{ caller_e164: "+15550001111", status: "completed", started_at: "2026-01-01T10:00:00Z" }]
      })
    );
    expect(item).toMatchObject({
      kind: "call",
      label: "Call — +15550001111 (completed)",
      href: "/dashboard/calls",
      at: "2026-01-01T10:00:00Z"
    });
    expect(item.id).toContain("call:0:");
  });

  it("falls back to 'unknown caller' when caller_e164 is null", () => {
    const [item] = buildActivityFeed(
      emptyInput({ calls: [{ caller_e164: null, status: "missed", started_at: "2026-01-01T10:00:00Z" }] })
    );
    expect(item.label).toBe("Call — unknown caller (missed)");
  });

  it("maps inbound SMS with parseable counterpart and skips unparseable ones", () => {
    const items = buildActivityFeed(
      emptyInput({
        smsInbound: [
          { payload: smsPayload("+15550002222"), created_at: "2026-01-02T10:00:00Z" },
          { payload: null, created_at: "2026-01-02T11:00:00Z" }
        ]
      })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "sms_inbound",
      label: "Text from +15550002222",
      href: "/dashboard/messages/%2B15550002222"
    });
  });

  it("maps outbound SMS and skips rows without to_e164", () => {
    const items = buildActivityFeed(
      emptyInput({
        smsOutbound: [
          { to_e164: "+15550003333", created_at: "2026-01-03T10:00:00Z" },
          { to_e164: null, created_at: "2026-01-03T11:00:00Z" }
        ]
      })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "sms_outbound",
      label: "Text to +15550003333",
      href: "/dashboard/messages/%2B15550003333"
    });
  });

  it("maps dashboard chat turns", () => {
    const [item] = buildActivityFeed(
      emptyInput({ chat: [{ created_at: "2026-01-04T10:00:00Z" }] })
    );
    expect(item).toMatchObject({ kind: "chat", label: "Dashboard chat", href: "/dashboard/chat" });
  });

  it("maps AiFlow runs across object, array, and null join shapes", () => {
    const items = buildActivityFeed(
      emptyInput({
        flows: [
          { status: "completed", created_at: "2026-01-05T12:00:00Z", ai_flows: { name: "Lead intake" } },
          { status: "failed", created_at: "2026-01-05T11:00:00Z", ai_flows: [{ name: "Nightly sync" }] },
          { status: "completed", created_at: "2026-01-05T10:00:00Z", ai_flows: null }
        ]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "AiFlow — Lead intake (completed)",
      "AiFlow — Nightly sync (failed)",
      "AiFlow — AiFlow (completed)"
    ]);
    expect(items[0]).toMatchObject({ kind: "aiflow", href: "/dashboard/aiflows" });
  });

  it("falls back to 'AiFlow' when an array join is empty", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        flows: [{ status: "completed", created_at: "2026-01-05T10:00:00Z", ai_flows: [] }]
      })
    );
    expect(item.label).toBe("AiFlow — AiFlow (completed)");
  });

  it("maps new customers with and without a display name", () => {
    const items = buildActivityFeed(
      emptyInput({
        customers: [
          { display_name: "Jane Doe", customer_e164: "+15550004444", created_at: "2026-01-06T10:00:00Z" },
          { display_name: null, customer_e164: "+15550005555", created_at: "2026-01-06T09:00:00Z" }
        ]
      })
    );
    expect(items[0]).toMatchObject({
      kind: "customer",
      label: "New customer — Jane Doe (+15550004444)",
      href: "/dashboard/customers/%2B15550004444"
    });
    expect(items[1].label).toBe("New customer — +15550005555");
  });

  it("labels urgent alerts by reason, then caller name, then task type", () => {
    const items = buildActivityFeed(
      emptyInput({
        alerts: [
          {
            task_type: "call",
            status: "urgent_alert",
            log_payload: { reason: "Pipe burst" },
            created_at: "2026-01-07T03:00:00Z"
          },
          {
            task_type: "call",
            status: "urgent_alert",
            log_payload: { callerName: "Pat" },
            created_at: "2026-01-07T02:00:00Z"
          },
          {
            task_type: "sms_reply",
            status: "error",
            log_payload: null,
            created_at: "2026-01-07T01:00:00Z"
          }
        ]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "Urgent — Pipe burst",
      "Urgent — Pat",
      "Issue — sms reply"
    ]);
    expect(items[0]).toMatchObject({ kind: "alert", href: "/dashboard/notifications" });
  });

  it("ignores blank payload fields when labeling alerts", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        alerts: [
          {
            task_type: "call",
            status: "urgent_alert",
            log_payload: { reason: "   ", callerName: "" },
            created_at: "2026-01-07T00:00:00Z"
          }
        ]
      })
    );
    expect(item.label).toBe("Urgent — call");
  });

  it("sorts newest-first across sources and caps to limit", () => {
    const items = buildActivityFeed(
      emptyInput({
        calls: [{ caller_e164: "+1", status: "ok", started_at: "2026-01-01T00:00:03Z" }],
        chat: [{ created_at: "2026-01-01T00:00:01Z" }],
        customers: [{ display_name: null, customer_e164: "+2", created_at: "2026-01-01T00:00:02Z" }],
        limit: 2
      })
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.at)).toEqual(["2026-01-01T00:00:03Z", "2026-01-01T00:00:02Z"]);
  });

  it("keeps stable order for identical timestamps", () => {
    const ts = "2026-01-01T00:00:00Z";
    const items = buildActivityFeed(
      emptyInput({
        chat: [{ created_at: ts }],
        customers: [{ display_name: null, customer_e164: "+9", created_at: ts }]
      })
    );
    expect(items.map((i) => i.kind)).toEqual(["chat", "customer"]);
  });
});

function chainResult(result: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result)
  };
}

/**
 * Build a fake supabase client whose `from(table)` returns a chain resolving
 * to the per-table result supplied in `byTable`.
 */
function mockDbByTable(byTable: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: vi.fn((table: string) => chainResult(byTable[table]))
  };
}

const ALL_EMPTY = {
  voice_call_transcripts: { data: [], error: null },
  sms_inbound_jobs: { data: [], error: null },
  sms_outbound_log: { data: [], error: null },
  dashboard_chat_jobs: { data: [], error: null },
  ai_flow_runs: { data: [], error: null },
  customer_memories: { data: [], error: null },
  coworker_logs: { data: [], error: null }
};

describe("getRecentActivity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges rows from every table into one feed", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      voice_call_transcripts: {
        data: [{ caller_e164: "+15550001111", status: "completed", started_at: "2026-02-01T10:00:00Z" }],
        error: null
      },
      dashboard_chat_jobs: { data: [{ created_at: "2026-02-01T09:00:00Z" }], error: null },
      coworker_logs: {
        data: [
          {
            task_type: "call",
            status: "urgent_alert",
            log_payload: { reason: "Flood" },
            created_at: "2026-02-01T11:00:00Z"
          }
        ],
        error: null
      }
    });

    const items = await getRecentActivity("biz-1", 10, db as never);
    expect(items.map((i) => i.kind)).toEqual(["alert", "call", "chat"]);
    expect(db.from).toHaveBeenCalledWith("voice_call_transcripts");
    expect(db.from).toHaveBeenCalledWith("ai_flow_runs");
    expect(db.from).toHaveBeenCalledWith("coworker_logs");
  });

  it("bounds every source to the recency window and filters alert statuses", async () => {
    const db = mockDbByTable(ALL_EMPTY);
    await getRecentActivity("biz-1", 10, db as never);
    const callChain = db.from.mock.results.find((r) => r.value.gte.mock.calls.length > 0)?.value;
    expect(callChain.gte).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    const logChain = db.from.mock.results[db.from.mock.calls.length - 1].value;
    expect(logChain.in).toHaveBeenCalledWith("status", ["urgent_alert", "error"]);
  });

  it("treats a failed source as empty instead of throwing", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      voice_call_transcripts: { data: null, error: { message: "boom" } },
      dashboard_chat_jobs: { data: [{ created_at: "2026-02-01T09:00:00Z" }], error: null }
    });

    const items = await getRecentActivity("biz-1", 10, db as never);
    expect(items.map((i) => i.kind)).toEqual(["chat"]);
  });

  it("handles a source returning null data without error", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      customer_memories: { data: null, error: null }
    });

    const items = await getRecentActivity("biz-1", 10, db as never);
    expect(items).toEqual([]);
  });

  it("creates a service client and uses the default limit when none provided", async () => {
    const db = mockDbByTable(ALL_EMPTY);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const items = await getRecentActivity("biz-1");
    expect(items).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    const chain = db.from.mock.results[0].value;
    expect(chain.limit).toHaveBeenCalledWith(DEFAULT_ACTIVITY_LIMIT);
  });
});
