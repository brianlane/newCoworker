import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));
vi.mock("@/lib/db/business-members", () => ({ getBusinessRoleForEmail: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({ listAccessibleBusinesses: vi.fn() }));
vi.mock("@/lib/customer-memory/db", () => ({
  listCustomerMemories: vi.fn(),
  getCustomerMemory: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/sms-history", () => ({ listMessagesForCustomer: vi.fn() }));
vi.mock("@/lib/db/voice-transcripts", () => ({
  getTranscriptById: vi.fn(),
  listTurns: vi.fn(),
  listTranscriptsForBusiness: vi.fn()
}));

import { searchTool, fetchTool } from "@/lib/mcp/tools/search";
import { McpToolError } from "@/lib/mcp/auth";
import { runTool } from "./helpers/run-mcp-tool";
import { logger } from "@/lib/logger";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { listAccessibleBusinesses } from "@/lib/dashboard/active-business";
import { listCustomerMemories, getCustomerMemory } from "@/lib/customer-memory/db";
import { getBusiness } from "@/lib/db/businesses";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { getTranscriptById, listTurns } from "@/lib/db/voice-transcripts";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const BIZ_A = "11111111-1111-4111-8111-111111111111";
const BIZ_B = "22222222-2222-4222-8222-222222222222";

function contact(e164: string, name: string | null) {
  return {
    customer_e164: e164,
    display_name: name,
    email: null,
    type: "customer",
    tags: [],
    pinned_md: null,
    summary_md: null,
    last_channel: "sms",
    last_interaction_at: "2026-08-01T00:00:00Z",
    total_interaction_count: 3
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner" as never);
  vi.mocked(listAccessibleBusinesses).mockResolvedValue([
    { businessId: BIZ_A, name: "A", tier: "standard", role: "owner" }
  ] as never);
  vi.mocked(listCustomerMemories).mockResolvedValue([] as never);
  vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_A, name: "A" } as never);
});

describe("search", () => {
  it("returns a profile AND a conversation per match, so both are reachable", async () => {
    // Message bodies are not searched (no full-text index), so the thread has
    // to be discoverable through the person. Without this, fetch could be
    // handed thread ids that search never produced.
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", "Maria")] as never);
    const result = (await runTool(searchTool, { query: "Maria" }, AUTH)) as {
      results: Array<{ id: string; title: string; url: string }>;
    };
    expect(result.results.map((r) => r.id)).toEqual([
      `contact:${BIZ_A}:+15551110000`,
      `thread:${BIZ_A}:+15551110000`
    ]);
    expect(result.results[0].url).toContain("/dashboard/customers/");
    expect(result.results[1].url).toContain("/dashboard/messages/");
  });

  it("falls back to the phone number when a contact has no name", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", null)] as never);
    const result = (await runTool(searchTool, { query: "555" }, AUTH)) as {
      results: Array<{ title: string }>;
    };
    expect(result.results[0].title).toBe("+15551110000");
  });

  it("searches every accessible business and labels which is which", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: BIZ_A, name: "A", tier: "standard", role: "owner" },
      { businessId: BIZ_B, name: "B", tier: "standard", role: "owner" }
    ] as never);
    vi.mocked(getBusiness).mockImplementation(
      async (id: string) => ({ id, name: id === BIZ_A ? "Acme" : "Beta" }) as never
    );
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", "Maria")] as never);

    const result = (await runTool(searchTool, { query: "Maria" }, AUTH)) as {
      results: Array<{ title: string }>;
    };
    // Two Marias in two businesses are otherwise indistinguishable.
    expect(result.results.some((r) => r.title.includes("(Acme)"))).toBe(true);
    expect(result.results.some((r) => r.title.includes("(Beta)"))).toBe(true);
  });

  it("does not label the business when there is only one", async () => {
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", "Maria")] as never);
    const result = (await runTool(searchTool, { query: "Maria" }, AUTH)) as {
      results: Array<{ title: string }>;
    };
    expect(result.results[0].title).toBe("Maria");
  });

  /**
   * On a multi-business account, reaching one you cannot read is the ordinary
   * case, not a refusal. Erroring would make search useless for exactly the
   * accounts that need it, and logging would bury real refusals under one
   * warning per business per query.
   */
  it("silently skips a business the caller cannot read, and logs nothing", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: BIZ_A, name: "A", tier: "standard", role: "owner" },
      { businessId: BIZ_B, name: "B", tier: "standard", role: "staff" }
    ] as never);
    vi.mocked(getBusinessRoleForEmail).mockImplementation(
      async (id: string) => (id === BIZ_A ? "owner" : null) as never
    );
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", "Maria")] as never);

    const result = (await runTool(searchTool, { query: "Maria" }, AUTH)) as {
      results: Array<{ id: string }>;
    };
    expect(result.results.every((r) => r.id.includes(BIZ_A))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("honors an explicit business instead of fanning out", async () => {
    await runTool(searchTool, { query: "Maria", business_id: BIZ_B }, AUTH);
    expect(listAccessibleBusinesses).not.toHaveBeenCalled();
    expect(listCustomerMemories).toHaveBeenCalledWith(BIZ_B, expect.anything());
  });

  it("refuses when the account has no businesses at all", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([] as never);
    await expect(runTool(searchTool, { query: "x" }, AUTH)).rejects.toThrow(McpToolError);
  });

  it("caps the fan-out so one query cannot sweep an unbounded account", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      businessId: `${i}`.padStart(8, "0") + "-1111-4111-8111-111111111111",
      name: `B${i}`,
      tier: "standard",
      role: "owner"
    }));
    vi.mocked(listAccessibleBusinesses).mockResolvedValue(many as never);
    await runTool(searchTool, { query: "x" }, AUTH);
    expect(vi.mocked(listCustomerMemories).mock.calls.length).toBe(5);
  });
});

describe("fetch", () => {
  it("reads a contact profile", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      ...contact("+15551110000", "Maria"),
      pinned_md: "VIP",
      summary_md: "Wants a quote"
    } as never);
    const result = (await runTool(
      fetchTool,
      { id: `contact:${BIZ_A}:+15551110000` },
      AUTH
    )) as { text: string; url: string };
    expect(result.text).toContain("Maria");
    expect(result.text).toContain("VIP");
    expect(result.url).toContain("/dashboard/customers/");
  });

  it("reads a whole conversation", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      { direction: "inbound", content: "hi", timestamp: "2026-08-01T00:00:00Z" },
      { direction: "outbound", content: "hello", timestamp: "2026-08-01T00:01:00Z" }
    ] as never);
    const result = (await runTool(
      fetchTool,
      { id: `thread:${BIZ_A}:+15551110000` },
      AUTH
    )) as { text: string };
    expect(result.text).toBe("inbound: hi\noutbound: hello");
  });

  it("says so plainly when a conversation is empty", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue([] as never);
    const result = (await runTool(fetchTool, { id: `thread:${BIZ_A}:+1555` }, AUTH)) as {
      text: string;
    };
    expect(result.text).toContain("no messages");
  });

  it("reads a call with its transcript, scoped to the business for residency", async () => {
    vi.mocked(getTranscriptById).mockResolvedValue({
      id: "call-1",
      caller_e164: "+15551110000",
      started_at: "2026-08-01T00:00:00Z",
      status: "completed",
      summary: "Asked about pricing"
    } as never);
    vi.mocked(listTurns).mockResolvedValue([
      { role: "caller", content: "how much?" },
      { role: "assistant", content: "it depends" }
    ] as never);

    const result = (await runTool(fetchTool, { id: `call:${BIZ_A}:call-1` }, AUTH)) as {
      text: string;
    };
    expect(result.text).toContain("Asked about pricing");
    expect(result.text).toContain("caller: how much?");
    // Turns carry no business_id of their own, so without this the read stays
    // central and a residency tenant's transcript comes back empty.
    expect(listTurns).toHaveBeenCalledWith("call-1", { businessId: BIZ_A });
  });

  /**
   * The security property of the whole design: an id names a business, it does
   * not grant one. Anyone can type an id for a business they cannot read.
   */
  it("checks the caller's live role, not the id", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null as never);
    await expect(
      runTool(fetchTool, { id: `contact:${BIZ_B}:+15551110000` }, AUTH)
    ).rejects.toThrow(/permission/i);
    expect(getCustomerMemory).not.toHaveBeenCalled();
  });

  it("refuses an id it never issued", async () => {
    await expect(runTool(fetchTool, { id: "not-an-id" }, AUTH)).rejects.toThrow(McpToolError);
    expect(getBusinessRoleForEmail).not.toHaveBeenCalled();
  });

  it("refuses a record that has since been deleted", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue(null as never);
    await expect(
      runTool(fetchTool, { id: `contact:${BIZ_A}:+1555` }, AUTH)
    ).rejects.toThrow(/no longer exists/);

    vi.mocked(getTranscriptById).mockResolvedValue(null as never);
    await expect(runTool(fetchTool, { id: `call:${BIZ_A}:gone` }, AUTH)).rejects.toThrow(
      /no longer exists/
    );
  });

  it("truncates a huge record instead of returning it whole", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue(
      Array.from({ length: 100 }, () => ({
        direction: "inbound",
        content: "x".repeat(500),
        timestamp: "2026-08-01T00:00:00Z"
      })) as never
    );
    const result = (await runTool(fetchTool, { id: `thread:${BIZ_A}:+1555` }, AUTH)) as {
      text: string;
    };
    expect(result.text.endsWith("[truncated]")).toBe(true);
  });
});

/**
 * The empty-record paths. Every one of these is a real row shape: a contact
 * captured from an inbound text has no name or email, a call that never got
 * summarized has no summary, and a transcript can exist with no turns. The
 * fallbacks are what stop a fetch rendering "undefined" at a person.
 */
describe("fetch, when the record is mostly empty", () => {
  it("renders a bare contact without printing undefined", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValue({
      customer_e164: "+15551110000",
      display_name: null,
      email: null,
      tags: null,
      last_interaction_at: null,
      pinned_md: null,
      summary_md: null
    } as never);
    const result = (await runTool(fetchTool, { id: `contact:${BIZ_A}:+1555` }, AUTH)) as {
      text: string;
    };
    expect(result.text).not.toContain("undefined");
    expect(result.text).toContain("(unknown)");
    expect(result.text).toContain("(none)");
    expect(result.text).toContain("(nothing yet)");
  });

  it("renders a message with no body", async () => {
    vi.mocked(listMessagesForCustomer).mockResolvedValue([
      { direction: "inbound", content: null, timestamp: "2026-08-01T00:00:00Z" }
    ] as never);
    const result = (await runTool(fetchTool, { id: `thread:${BIZ_A}:+1555` }, AUTH)) as {
      text: string;
    };
    expect(result.text).toBe("inbound: ");
  });

  it("renders a call with nothing captured", async () => {
    vi.mocked(getTranscriptById).mockResolvedValue({
      id: "call-1",
      caller_e164: null,
      started_at: null,
      status: null,
      summary: null
    } as never);
    vi.mocked(listTurns).mockResolvedValue([] as never);
    const result = (await runTool(fetchTool, { id: `call:${BIZ_A}:call-1` }, AUTH)) as {
      text: string;
    };
    expect(result.text).not.toContain("undefined");
    expect(result.text).toContain("(unknown)");
    expect(result.text).toContain("(no transcript captured)");
  });

  it("omits the business label when the business has no name", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: BIZ_A, name: "A", tier: "standard", role: "owner" },
      { businessId: BIZ_B, name: "B", tier: "standard", role: "owner" }
    ] as never);
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    vi.mocked(listCustomerMemories).mockResolvedValue([contact("+15551110000", "Maria")] as never);
    const result = (await runTool(searchTool, { query: "Maria" }, AUTH)) as {
      results: Array<{ title: string }>;
    };
    expect(result.results[0].title).toBe("Maria");
  });
});

/**
 * The gap review caught: `fetch` reads calls, and the only place a model can
 * get a call id is `list_call_transcripts`. That tool returned a bare UUID,
 * so every call id a model could actually obtain was one `fetch` refused.
 * This walks the real round trip rather than asserting the format twice.
 */
describe("call ids survive the trip from list_call_transcripts to fetch", () => {
  it("accepts the fetch_id that list_call_transcripts emits", async () => {
    const { listCallTranscriptsTool } = await import("@/lib/mcp/tools/read");
    const { listTranscriptsForBusiness } = await import("@/lib/db/voice-transcripts");
    vi.mocked(listTranscriptsForBusiness).mockResolvedValue([
      { id: "call-1", caller_e164: "+15551110000", summary: "Pricing" }
    ] as never);
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: BIZ_A, name: "A", tier: "standard", role: "owner" }
    ] as never);

    const listed = (await listCallTranscriptsTool.handler({}, AUTH)) as {
      calls: Array<{ fetch_id: string }>;
    };
    const id = listed.calls[0].fetch_id;

    vi.mocked(getTranscriptById).mockResolvedValue({
      id: "call-1",
      caller_e164: "+15551110000",
      started_at: null,
      status: null,
      summary: "Pricing"
    } as never);
    vi.mocked(listTurns).mockResolvedValue([] as never);

    const fetched = (await runTool(fetchTool, { id }, AUTH)) as { text: string };
    expect(fetched.text).toContain("Pricing");
  });
});
