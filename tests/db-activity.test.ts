import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildActivityFeed,
  buildFullActivityFeed,
  collectActivityItems,
  getRecentActivity,
  getAllRecentActivity,
  DEFAULT_ACTIVITY_LIMIT,
  ACTIVITY_FEED_MAX,
  type ActivityFeedInput
} from "@/lib/db/activity";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/contact-names", () => ({
  resolveContactNames: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";

function emptyInput(overrides: Partial<ActivityFeedInput> = {}): ActivityFeedInput {
  return {
    calls: [],
    smsInbound: [],
    smsReplies: [],
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

  it("emits coworker replies as 'Text out' items and skips unparseable ones", () => {
    const items = buildActivityFeed(
      emptyInput({
        smsReplies: [
          { payload: smsPayload("+15550002222"), updated_at: "2026-01-02T10:05:00Z" },
          { payload: null, updated_at: "2026-01-02T09:05:00Z" }
        ]
      })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "sms_outbound",
      label: "Text to +15550002222",
      href: "/dashboard/messages/%2B15550002222",
      at: "2026-01-02T10:05:00Z"
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

  it("shows known contact names in call and text labels, falling back to the number", () => {
    const contactNames = new Map<string, ContactName>([
      ["+15550001111", { name: "Mike Haas", kind: "customer" }],
      ["+15550002222", { name: "Pat (employee)", kind: "employee" }]
    ]);
    const items = buildActivityFeed(
      emptyInput({
        contactNames,
        calls: [
          { caller_e164: "+15550001111", status: "completed", started_at: "2026-01-01T10:00:00Z" },
          // No name on file: still rendered as the raw number.
          { caller_e164: "+19998887777", status: "missed", started_at: "2026-01-01T09:00:00Z" }
        ],
        smsInbound: [{ payload: smsPayload("+15550002222"), created_at: "2026-01-01T08:00:00Z" }],
        smsReplies: [{ payload: smsPayload("+15550001111"), updated_at: "2026-01-01T07:00:00Z" }],
        smsOutbound: [{ to_e164: "+15550002222", created_at: "2026-01-01T06:00:00Z" }]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "Call — Mike Haas (completed)",
      "Call — +19998887777 (missed)",
      "Text from Pat (employee)",
      "Text to Mike Haas",
      "Text to Pat (employee)"
    ]);
  });

  it("uses the resolver for new-customer labels, overriding display_name", () => {
    const items = buildActivityFeed(
      emptyInput({
        contactNames: new Map<string, ContactName>([
          ["+15550004444", { name: "Pat (override)", kind: "contact", override: true }],
          ["+15550005555", { name: "Owner", kind: "owner" }]
        ]),
        customers: [
          // Resolver name wins over the row's own display_name.
          { display_name: "Stale Name", customer_e164: "+15550004444", created_at: "2026-01-06T10:00:00Z" },
          // No display_name on the row, but the number is a known contact.
          { display_name: null, customer_e164: "+15550005555", created_at: "2026-01-06T09:00:00Z" }
        ]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "New customer — Pat (override) (+15550004444)",
      "New customer — Owner (+15550005555)"
    ]);
  });

  it("keeps the deep-link href on the raw number even when a name is shown", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        contactNames: new Map<string, ContactName>([
          ["+15550003333", { name: "Owner", kind: "owner" }]
        ]),
        smsOutbound: [{ to_e164: "+15550003333", created_at: "2026-01-03T10:00:00Z" }]
      })
    );
    expect(item.label).toBe("Text to Owner");
    expect(item.href).toBe("/dashboard/messages/%2B15550003333");
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
          { id: "run-1", flow_id: "flow-a", status: "completed", created_at: "2026-01-05T12:00:00Z", ai_flows: { name: "Lead intake" } },
          { id: "run-2", flow_id: "flow-b", status: "failed", created_at: "2026-01-05T11:00:00Z", ai_flows: [{ name: "Nightly sync" }] },
          { id: "run-3", flow_id: "flow-c", status: "completed", created_at: "2026-01-05T10:00:00Z", ai_flows: null }
        ]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "AiFlow — Lead intake (completed)",
      "AiFlow — Nightly sync (failed)",
      "AiFlow — AiFlow (completed)"
    ]);
    // Deep links to the exact run on the flow's runs page (not the flow list).
    expect(items[0]).toMatchObject({
      kind: "aiflow",
      href: "/dashboard/aiflows/runs?flowId=flow-a&run=run-1"
    });
    expect(items[1].href).toBe("/dashboard/aiflows/runs?flowId=flow-b&run=run-2");
  });

  it("falls back to 'AiFlow' when an array join is empty", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        flows: [{ id: "run-x", flow_id: "flow-x", status: "completed", created_at: "2026-01-05T10:00:00Z", ai_flows: [] }]
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
            log_payload: { reason: "Pipe burst" },
            created_at: "2026-01-07T03:00:00Z"
          },
          {
            task_type: "call",
            log_payload: { callerName: "Pat" },
            created_at: "2026-01-07T02:00:00Z"
          },
          {
            task_type: "sms_reply",
            log_payload: null,
            created_at: "2026-01-07T01:00:00Z"
          }
        ]
      })
    );
    expect(items.map((i) => i.label)).toEqual([
      "Urgent — Pipe burst",
      "Urgent — Pat",
      "Urgent — sms reply"
    ]);
    expect(items[0]).toMatchObject({ kind: "alert", href: "/dashboard/notifications" });
  });

  it("ignores blank payload fields when labeling alerts", () => {
    const [item] = buildActivityFeed(
      emptyInput({
        alerts: [
          {
            task_type: "call",
            log_payload: { reason: "   ", callerName: "" },
            created_at: "2026-01-07T00:00:00Z"
          }
        ]
      })
    );
    expect(item.label).toBe("Urgent — call");
  });

  it("reserves slots for alerts so routine events can't push them off", () => {
    const items = buildActivityFeed(
      emptyInput({
        // One old urgent alert plus three newer routine calls, limit 2.
        alerts: [{ task_type: "call", log_payload: { reason: "Gas leak" }, created_at: "2026-01-01T00:00:00Z" }],
        calls: [
          { caller_e164: "+1", status: "ok", started_at: "2026-01-09T00:00:00Z" },
          { caller_e164: "+2", status: "ok", started_at: "2026-01-08T00:00:00Z" },
          { caller_e164: "+3", status: "ok", started_at: "2026-01-07T00:00:00Z" }
        ],
        limit: 2
      })
    );
    expect(items).toHaveLength(2);
    // Newest routine call shown, but the old alert is retained (last by recency).
    expect(items.map((i) => i.kind)).toEqual(["call", "alert"]);
    expect(items[1].label).toBe("Urgent — Gas leak");
  });

  it("caps alerts at half the feed so newer activity still appears", () => {
    const items = buildActivityFeed(
      emptyInput({
        alerts: [
          { task_type: "call", log_payload: { reason: "A1" }, created_at: "2026-02-01T04:00:00Z" },
          { task_type: "call", log_payload: { reason: "A2" }, created_at: "2026-02-01T03:00:00Z" },
          { task_type: "call", log_payload: { reason: "A3" }, created_at: "2026-02-01T02:00:00Z" },
          { task_type: "call", log_payload: { reason: "A4" }, created_at: "2026-02-01T01:00:00Z" }
        ],
        calls: [
          { caller_e164: "+1", status: "ok", started_at: "2026-02-02T10:00:00Z" },
          { caller_e164: "+2", status: "ok", started_at: "2026-02-02T09:00:00Z" }
        ],
        limit: 4
      })
    );
    const kinds = items.map((i) => i.kind);
    expect(items).toHaveLength(4);
    expect(kinds.filter((k) => k === "alert")).toHaveLength(2);
    expect(kinds.filter((k) => k === "call")).toHaveLength(2);
  });

  it("backfills remaining slots with alerts when there is no other activity", () => {
    const items = buildActivityFeed(
      emptyInput({
        alerts: [
          { task_type: "call", log_payload: { reason: "A1" }, created_at: "2026-03-01T04:00:00Z" },
          { task_type: "call", log_payload: { reason: "A2" }, created_at: "2026-03-01T03:00:00Z" },
          { task_type: "call", log_payload: { reason: "A3" }, created_at: "2026-03-01T02:00:00Z" },
          { task_type: "call", log_payload: { reason: "A4" }, created_at: "2026-03-01T01:00:00Z" }
        ],
        limit: 3
      })
    );
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === "alert")).toBe(true);
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

describe("collectActivityItems", () => {
  it("returns every source unranked (no alert reservation/cap)", () => {
    const items = collectActivityItems(
      emptyInput({
        // A tiny limit would force the card's reservation logic to drop items;
        // collect ignores limit entirely and keeps all of them.
        limit: 1,
        calls: [{ caller_e164: "+1", status: "ok", started_at: "2026-01-02T00:00:00Z" }],
        alerts: [{ task_type: "call", log_payload: { reason: "X" }, created_at: "2026-01-01T00:00:00Z" }]
      })
    );
    expect(items).toHaveLength(2);
    // Insertion order (calls before alerts), NOT recency-sorted.
    expect(items.map((i) => i.kind)).toEqual(["call", "alert"]);
  });
});

describe("buildFullActivityFeed", () => {
  it("ranks strictly by recency with no alert reservation", () => {
    const items = buildFullActivityFeed(
      emptyInput({
        // Three newer routine calls plus one old alert; the card would reserve a
        // slot for the alert, but the full feed is pure recency.
        alerts: [{ task_type: "call", log_payload: { reason: "Old" }, created_at: "2026-01-01T00:00:00Z" }],
        calls: [
          { caller_e164: "+1", status: "ok", started_at: "2026-01-09T00:00:00Z" },
          { caller_e164: "+2", status: "ok", started_at: "2026-01-08T00:00:00Z" },
          { caller_e164: "+3", status: "ok", started_at: "2026-01-07T00:00:00Z" }
        ],
        limit: 3
      })
    );
    expect(items.map((i) => i.kind)).toEqual(["call", "call", "call"]);
  });

  it("caps the merged feed to limit", () => {
    const items = buildFullActivityFeed(
      emptyInput({
        chat: [
          { created_at: "2026-01-03T00:00:00Z" },
          { created_at: "2026-01-02T00:00:00Z" },
          { created_at: "2026-01-01T00:00:00Z" }
        ],
        limit: 2
      })
    );
    expect(items.map((i) => i.at)).toEqual(["2026-01-03T00:00:00Z", "2026-01-02T00:00:00Z"]);
  });
});

function chainResult(result: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
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
  contacts: { data: [], error: null },
  coworker_logs: { data: [], error: null }
};

describe("getRecentActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no known contacts, so labels show raw numbers.
    vi.mocked(resolveContactNames).mockResolvedValue(new Map<string, ContactName>());
  });

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

  it("bounds every source to the recency window and filters to urgent alerts", async () => {
    const db = mockDbByTable(ALL_EMPTY);
    await getRecentActivity("biz-1", 10, db as never);
    const callChain = db.from.mock.results.find((r) => r.value.gte.mock.calls.length > 0)?.value;
    expect(callChain.gte).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    const logChain = db.from.mock.results[db.from.mock.calls.length - 1].value;
    expect(logChain.eq).toHaveBeenCalledWith("status", "urgent_alert");
    // Replies are queried on their own updated_at window (not null reply).
    const replyChain = db.from.mock.results.find((r) => r.value.not.mock.calls.length > 0)?.value;
    expect(replyChain.not).toHaveBeenCalledWith("assistant_reply_text", "is", null);
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
      contacts: { data: null, error: null }
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

  it("resolves contact names across every phone-bearing source", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      voice_call_transcripts: {
        data: [
          { caller_e164: "+15550001111", status: "completed", started_at: "2026-02-01T10:00:00Z" },
          // Null number is filtered out before the resolver call.
          { caller_e164: null, status: "missed", started_at: "2026-02-01T09:00:00Z" }
        ],
        error: null
      },
      // Both the inbound and reply queries read sms_inbound_jobs.
      sms_inbound_jobs: {
        data: [{ payload: smsPayload("+15550002222"), created_at: "2026-02-01T08:00:00Z", updated_at: "2026-02-01T08:30:00Z" }],
        error: null
      },
      sms_outbound_log: {
        data: [{ to_e164: "+15550003333", created_at: "2026-02-01T07:00:00Z" }],
        error: null
      },
      contacts: {
        data: [{ display_name: null, customer_e164: "+15550004444", created_at: "2026-02-01T06:00:00Z" }],
        error: null
      }
    });
    vi.mocked(resolveContactNames).mockResolvedValue(
      new Map<string, ContactName>([["+15550001111", { name: "Mike Haas", kind: "customer" }]])
    );

    const items = await getRecentActivity("biz-1", 10, db as never);
    expect(resolveContactNames).toHaveBeenCalledWith(
      "biz-1",
      ["+15550001111", "+15550002222", "+15550002222", "+15550003333", "+15550004444"],
      db
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Call — Mike Haas (completed)");
    expect(labels).toContain("Call — unknown caller (missed)");
    expect(labels).toContain("Text from +15550002222");
    expect(labels).toContain("Text to +15550003333");
    expect(labels).toContain("New customer — +15550004444");
  });

  it("falls back to raw numbers when the contact resolver fails", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      sms_outbound_log: {
        data: [{ to_e164: "+15550002222", created_at: "2026-02-01T08:00:00Z" }],
        error: null
      }
    });
    vi.mocked(resolveContactNames).mockRejectedValue(new Error("resolver down"));

    const items = await getRecentActivity("biz-1", 10, db as never);
    expect(items.map((i) => i.label)).toEqual(["Text to +15550002222"]);
  });
});

describe("getAllRecentActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveContactNames).mockResolvedValue(new Map<string, ContactName>());
  });

  it("ranks strictly by recency (no alert reservation) so AiFlow runs surface", async () => {
    const db = mockDbByTable({
      ...ALL_EMPTY,
      // An older AiFlow run plus a newer alert: the recency-only full feed keeps
      // both and orders the alert first (it is newer), unlike the card which
      // would slot-reserve the alert regardless of age.
      ai_flow_runs: {
        data: [
          {
            id: "run-1",
            flow_id: "flow-a",
            status: "completed",
            created_at: "2026-02-01T08:00:00Z",
            ai_flows: { name: "ReferralExchange lead" }
          }
        ],
        error: null
      },
      coworker_logs: {
        data: [
          {
            task_type: "call",
            status: "urgent_alert",
            log_payload: { reason: "Flood" },
            created_at: "2026-02-01T10:00:00Z"
          }
        ],
        error: null
      }
    });

    const items = await getAllRecentActivity("biz-1", 50, db as never);
    expect(items.map((i) => i.kind)).toEqual(["alert", "aiflow"]);
    expect(items[1].label).toBe("AiFlow — ReferralExchange lead (completed)");
  });

  it("creates a service client and uses ACTIVITY_FEED_MAX when no limit is given", async () => {
    const db = mockDbByTable(ALL_EMPTY);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const items = await getAllRecentActivity("biz-1");
    expect(items).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    const chain = db.from.mock.results[0].value;
    expect(chain.limit).toHaveBeenCalledWith(ACTIVITY_FEED_MAX);
  });
});
