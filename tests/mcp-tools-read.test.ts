import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/dashboard/active-business", () => ({
  listAccessibleBusinesses: vi.fn()
}));
vi.mock("@/lib/customer-memory/db", () => ({
  listCustomerMemories: vi.fn(),
  getCustomerMemory: vi.fn()
}));
vi.mock("@/lib/db/sms-history", () => ({
  listMessagesForCustomer: vi.fn()
}));
vi.mock("@/lib/db/voice-transcripts", () => ({
  listTranscriptsForBusiness: vi.fn()
}));
vi.mock("@/lib/db/implicit-contact-owner", () => ({
  resolveImplicitContactOwner: vi.fn(async () => null)
}));

const serviceClientMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => serviceClientMock())
}));

import { resolveImplicitContactOwner } from "@/lib/db/implicit-contact-owner";
import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  getBusinessTool,
  getContactTool,
  getSmsThreadTool,
  listBusinessesTool,
  listCallTranscriptsTool,
  listRecentEventsTool,
  listTasksTool,
  normalizePhoneArg,
  searchContactsTool
} from "@/lib/mcp/tools/read";
import { listAccessibleBusinesses } from "@/lib/dashboard/active-business";
import { getCustomerMemory, listCustomerMemories } from "@/lib/customer-memory/db";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { listTranscriptsForBusiness } from "@/lib/db/voice-transcripts";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

/** Chainable PostgREST-style fake resolving to `terminal`. */
function chain(terminal: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "eq", "neq", "in", "is", "order", "limit", "filter", "or"]) {
    c[m] = vi.fn(() => c);
  }
  c.maybeSingle = vi.fn(async () => terminal);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
});

describe("normalizePhoneArg", () => {
  it("coerces owner-typed input to E.164", () => {
    expect(normalizePhoneArg("(305) 613-3412")).toBe("+13056133412");
  });

  it("refuses garbage with the normalizer's reason", () => {
    expect(() => normalizePhoneArg("not a phone")).toThrow(McpToolError);
  });
});

describe("list_businesses", () => {
  it("maps accessible businesses with roles", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: "biz-1", name: "One", tier: "starter", role: "owner", created_at: "x" },
      { businessId: "biz-2", name: "Two", tier: "standard", role: "staff", created_at: "y" }
    ]);
    const result = (await runTool(listBusinessesTool, {}, AUTH)) as {
      businesses: unknown[];
    };
    expect(result.businesses).toEqual([
      { business_id: "biz-1", name: "One", tier: "starter", role: "owner" },
      { business_id: "biz-2", name: "Two", tier: "standard", role: "staff" }
    ]);
  });
});

describe("get_business", () => {
  it("returns the business profile", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn(() =>
        chain({
          data: {
            id: "biz-1",
            name: "One",
            tier: "starter",
            status: "active",
            timezone: "America/New_York",
            created_at: "2026-01-01"
          },
          error: null
        })
      )
    });
    const result = await runTool(getBusinessTool, {}, AUTH);
    expect(result).toEqual({
      business_id: "biz-1",
      name: "One",
      tier: "starter",
      status: "active",
      timezone: "America/New_York",
      created_at: "2026-01-01"
    });
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "view_dashboard");
  });

  it("nulls a missing timezone and errors on a missing row", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn(() =>
        chain({
          data: { id: "b", name: "n", tier: "t", status: "s", timezone: null, created_at: "c" },
          error: null
        })
      )
    });
    const ok = (await runTool(getBusinessTool, { business_id: "b" }, AUTH)) as {
      timezone: string | null;
    };
    expect(ok.timezone).toBeNull();

    serviceClientMock.mockReturnValue({
      from: vi.fn(() => chain({ data: null, error: { message: "gone" } }))
    });
    await expect(runTool(getBusinessTool, {}, AUTH)).rejects.toThrow(/not found/i);
  });
});

describe("search_contacts", () => {
  it("lists contacts with the default limit", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValue([
      {
        customer_e164: "+15550001111",
        display_name: "Ann",
        type: "customer",
        tags: ["New Lead"],
        last_channel: "sms",
        last_interaction_at: "2026-07-01",
        total_interaction_count: 4
      } as never
    ]);
    const result = (await runTool(searchContactsTool, { search: "ann" }, AUTH)) as {
      contacts: unknown[];
    };
    expect(listCustomerMemories).toHaveBeenCalledWith("biz-1", { search: "ann", limit: 50 });
    expect(result.contacts).toEqual([
      {
        phone: "+15550001111",
        name: "Ann",
        type: "customer",
        tags: ["New Lead"],
        last_channel: "sms",
        last_interaction_at: "2026-07-01",
        total_interactions: 4
      }
    ]);
  });

  it("honors an explicit limit", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValue([]);
    await runTool(searchContactsTool, { limit: 5 }, AUTH);
    expect(listCustomerMemories).toHaveBeenCalledWith("biz-1", { search: undefined, limit: 5 });
  });
});

/** A full profile row, so the tool's outputSchema accepts what it returns. */
const CONTACT_ROW = {
  customer_e164: "+15550001111",
  display_name: "Ann",
  email: "ann@x.com",
  type: "customer",
  tags: [],
  birthday: null,
  pinned_md: null,
  summary_md: null,
  last_channel: "voice",
  last_interaction_at: "2026-07-01",
  total_interaction_count: 9
};

describe("get_contact", () => {
  it("returns the full profile", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15550001111",
      display_name: "Ann",
      email: "ann@x.com",
      type: "customer",
      tags: [],
      owner_employee_id: null,
      birthday: null,
      pinned_md: "VIP",
      summary_md: "Long-time customer",
      last_channel: "voice",
      last_interaction_at: "2026-07-01",
      total_interaction_count: 9
    } as never);
    const result = (await runTool(getContactTool, { phone: "555-000-1111" }, AUTH)) as {
      phone: string;
      ai_summary: string;
    };
    expect(getCustomerMemory).toHaveBeenCalledWith("biz-1", "+15550001111");
    expect(result.phone).toBe("+15550001111");
    expect(result.ai_summary).toBe("Long-time customer");
  });

  /**
   * HQ, Aug 18 2026. A one-person team whose only member is the owner has no
   * unowned contacts, so the AI is told who holds the lead instead of
   * "nobody", the same answer the dashboard shows.
   */
  it("names the implicit one-person-team owner for an unclaimed contact", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      ...CONTACT_ROW,
      owner_employee_id: null
    } as never);
    vi.mocked(resolveImplicitContactOwner).mockResolvedValue({
      id: "mem-owner",
      name: "Brian"
    });
    const result = (await runTool(getContactTool, { phone: "+15550001111" }, AUTH)) as {
      owner_employee_id: string | null;
    };
    expect(result.owner_employee_id).toBe("mem-owner");
  });

  it("keeps a claimed contact's owner and pays for no ownership read", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      ...CONTACT_ROW,
      owner_employee_id: "emp-9"
    } as never);
    const result = (await runTool(getContactTool, { phone: "+15550001111" }, AUTH)) as {
      owner_employee_id: string | null;
    };
    expect(result.owner_employee_id).toBe("emp-9");
    expect(resolveImplicitContactOwner).not.toHaveBeenCalled();
  });

  it("errors when the contact does not exist", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(null);
    await expect(
      runTool(getContactTool, { phone: "+15550001111" }, AUTH)
    ).rejects.toThrow(/No contact found/);
  });
});

describe("get_sms_thread", () => {
  it("maps messages, including optional source/channel", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      {
        id: "1:inbound",
        jobId: "1",
        direction: "inbound",
        content: "hi",
        timestamp: "t1",
        status: "done",
        lastError: null
      },
      {
        id: "2:flow-outbound",
        jobId: "2",
        direction: "outbound",
        content: "hello",
        timestamp: "t2",
        status: "done",
        lastError: null,
        source: "ai_flow",
        channel: "rcs"
      }
    ] as never);
    const result = (await runTool(getSmsThreadTool, { phone: "+15550001111" }, AUTH)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(listMessagesForCustomer).toHaveBeenCalledWith("biz-1", "+15550001111", { limit: 50 });
    expect(result.messages).toEqual([
      { direction: "inbound", text: "hi", at: "t1" },
      { direction: "outbound", text: "hello", at: "t2", source: "ai_flow", channel: "rcs" }
    ]);
  });

  it("honors an explicit limit", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue([]);
    await runTool(getSmsThreadTool, { phone: "+15550001111", limit: 10 }, AUTH);
    expect(listMessagesForCustomer).toHaveBeenCalledWith("biz-1", "+15550001111", { limit: 10 });
  });
});

describe("list_recent_events", () => {
  it("rejects unknown event types", async () => {
    await expect(
      runTool(listRecentEventsTool, { event: "nope" }, AUTH)
    ).rejects.toThrow(/event must be one of/);
  });

  it("returns dispatcher-shaped payloads for sms.outbound", async () => {
    const c = chain({
      data: [
        {
          id: "row-1",
          business_id: "biz-1",
          to_e164: "+15550001111",
          from_e164: "+15559998888",
          body: "yo",
          source: "api",
          channel: "sms",
          created_at: "2026-07-01T00:00:00Z"
        }
      ],
      error: null
    });
    serviceClientMock.mockReturnValue({ from: vi.fn(() => c) });
    const result = (await runTool(listRecentEventsTool, 
      { event: "sms.outbound" },
      AUTH
    )) as { events: Array<{ event: string; data: Record<string, unknown> }> };
    expect(result.events[0].event).toBe("sms.outbound");
    expect(result.events[0].data.to).toBe("+15550001111");
    // No filter/readyOr for sms.outbound.
    expect(c.filter).not.toHaveBeenCalled();
    expect(c.or).not.toHaveBeenCalled();
  });

  it("applies the filter + readiness gate for call.completed", async () => {
    const c = chain({ data: [], error: null });
    serviceClientMock.mockReturnValue({ from: vi.fn(() => c) });
    const result = (await runTool(listRecentEventsTool, 
      { event: "call.completed", limit: 3 },
      AUTH
    )) as { events: unknown[] };
    expect(result.events).toEqual([]);
    expect(c.filter).toHaveBeenCalledWith("ended_at", "not.is", "null");
    expect(c.or).toHaveBeenCalled();
    expect(c.limit).toHaveBeenCalledWith(3);
  });

  it("surfaces query errors", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn(() => chain({ data: null, error: { message: "boom" } }))
    });
    await expect(
      runTool(listRecentEventsTool, { event: "sms.inbound" }, AUTH)
    ).rejects.toThrow(/Could not load events: boom/);
  });

  it("treats a null data payload as no events", async () => {
    serviceClientMock.mockReturnValue({
      from: vi.fn(() => chain({ data: null, error: null }))
    });
    const result = (await runTool(listRecentEventsTool, 
      { event: "sms.inbound" },
      AUTH
    )) as { events: unknown[] };
    expect(result.events).toEqual([]);
  });
});

describe("list_call_transcripts", () => {
  it("maps transcript rows", async () => {
    vi.mocked(listTranscriptsForBusiness).mockResolvedValue([
      {
        id: "t1",
        caller_e164: "+15550001111",
        direction: "inbound",
        call_kind: "ai",
        status: "completed",
        started_at: "s",
        ended_at: "e",
        summary: "Asked about pricing",
        sentiment: "positive"
      } as never
    ]);
    const result = (await runTool(listCallTranscriptsTool, { limit: 7 }, AUTH)) as {
      calls: Array<Record<string, unknown>>;
    };
    expect(listTranscriptsForBusiness).toHaveBeenCalledWith("biz-1", { limit: 7 });
    expect(result.calls[0]).toEqual({
      id: "t1",
      // The id fetch actually accepts. A bare UUID would make every call id a
      // model can obtain unusable, since fetch needs the business too.
      fetch_id: "call:biz-1:t1",
      caller: "+15550001111",
      direction: "inbound",
      kind: "ai",
      status: "completed",
      started_at: "s",
      ended_at: "e",
      summary: "Asked about pricing",
      sentiment: "positive"
    });
  });

  it("uses the default limit", async () => {
    vi.mocked(listTranscriptsForBusiness).mockResolvedValue([]);
    await runTool(listCallTranscriptsTool, {}, AUTH);
    expect(listTranscriptsForBusiness).toHaveBeenCalledWith("biz-1", { limit: 25 });
  });
});

describe("list_tasks", () => {
  function tasksDb(opts: {
    runs?: unknown;
    runsError?: { message: string } | null;
    flows?: unknown;
    flowsError?: { message: string } | null;
    tagged?: unknown;
    taggedError?: { message: string } | null;
  }) {
    // `undefined` means "not exercised" (default []); an explicit null must
    // reach the handler as-is to cover the `?? []` fallbacks.
    const val = (v: unknown) => (v === undefined ? [] : v);
    const from = vi.fn((table: string) => {
      if (table === "ai_flow_runs") {
        return chain({ data: val(opts.runs), error: opts.runsError ?? null });
      }
      if (table === "ai_flows") {
        return chain({ data: val(opts.flows), error: opts.flowsError ?? null });
      }
      return chain({ data: val(opts.tagged), error: opts.taggedError ?? null });
    });
    serviceClientMock.mockReturnValue({ from });
    return from;
  }

  const RUN = {
    id: "run-1",
    flow_id: "flow-1",
    status: "awaiting_reply",
    context: { vars: { lead_phone: "+15550001111" } },
    updated_at: "2026-07-01"
  };

  it("combines active runs (with flow names) and tagged contacts", async () => {
    tasksDb({
      runs: [RUN, { ...RUN, id: "run-2", flow_id: "flow-2", context: {} }],
      flows: [{ id: "flow-1", name: "Lead follow-up" }],
      tagged: [
        {
          customer_e164: "+15550002222",
          display_name: "Bob",
          tags: ["Booked"],
          updated_at: "2026-07-02"
        },
        { customer_e164: "+15550003333", display_name: null, tags: null, updated_at: "2026-07-03" }
      ]
    });
    const result = (await runTool(listTasksTool, {}, AUTH)) as {
      active_runs: Array<Record<string, unknown>>;
      tagged_contacts: Array<Record<string, unknown>>;
    };
    expect(result.active_runs).toEqual([
      {
        run_id: "run-1",
        flow: "Lead follow-up",
        status: "awaiting_reply",
        lead_phone: "+15550001111",
        updated_at: "2026-07-01"
      },
      // flow-2 has no row → generic name; empty context → no lead phone.
      {
        run_id: "run-2",
        flow: "AiFlow",
        status: "awaiting_reply",
        lead_phone: null,
        updated_at: "2026-07-01"
      }
    ]);
    expect(result.tagged_contacts).toEqual([
      { phone: "+15550002222", name: "Bob", tags: ["Booked"], updated_at: "2026-07-02" },
      { phone: "+15550003333", name: null, tags: [], updated_at: "2026-07-03" }
    ]);
  });

  it("skips the flows query when there are no active runs", async () => {
    const from = tasksDb({ runs: [], tagged: [] });
    const result = (await runTool(listTasksTool, { limit: 5 }, AUTH)) as {
      active_runs: unknown[];
    };
    expect(result.active_runs).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("ai_flows");
  });

  it("tolerates a null run context", async () => {
    tasksDb({
      runs: [{ ...RUN, context: null }],
      flows: [{ id: "flow-1", name: "F" }],
      tagged: []
    });
    const result = (await runTool(listTasksTool, {}, AUTH)) as {
      active_runs: Array<{ lead_phone: string | null }>;
    };
    expect(result.active_runs[0].lead_phone).toBeNull();
  });

  it("treats null query payloads as empty sets", async () => {
    tasksDb({ runs: null, tagged: null });
    const empty = (await runTool(listTasksTool, {}, AUTH)) as {
      active_runs: unknown[];
      tagged_contacts: unknown[];
    };
    expect(empty.active_runs).toEqual([]);
    expect(empty.tagged_contacts).toEqual([]);

    tasksDb({ runs: [RUN], flows: null, tagged: [] });
    const noFlows = (await runTool(listTasksTool, {}, AUTH)) as {
      active_runs: Array<{ flow: string }>;
    };
    expect(noFlows.active_runs[0].flow).toBe("AiFlow");
  });

  it("surfaces each query's errors", async () => {
    tasksDb({ runsError: { message: "r" } });
    await expect(runTool(listTasksTool, {}, AUTH)).rejects.toThrow(/workflow runs: r/);

    tasksDb({ runs: [RUN], flowsError: { message: "f" } });
    await expect(runTool(listTasksTool, {}, AUTH)).rejects.toThrow(/flows: f/);

    tasksDb({ runs: [RUN], flows: [], taggedError: { message: "t" } });
    await expect(runTool(listTasksTool, {}, AUTH)).rejects.toThrow(/tagged contacts: t/);
  });
});
