import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data: unknown; error: { message: string } | null };

/**
 * Chainable + thenable PostgREST builder stub: `.select().eq()` chains keep
 * returning the builder; awaiting the builder (listAgentToolSettings) or
 * calling `.maybeSingle()` / `.single()` resolves the configured result.
 */
function makeBuilder(result: StubResult) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    upsert: vi.fn(() => b),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: StubResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
  };
  return b;
}

const supabaseStub = { from: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

import {
  isAgentToolEnabled,
  resolveAgentTools,
  upsertAgentToolSetting
} from "@/lib/db/agent-tool-settings";
import { AGENT_TOOL_REGISTRY, findAgentToolDefinition } from "@/lib/agent-tools/registry";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registry invariants", () => {
  it("has unique tool keys per agent", () => {
    for (const agent of AGENT_TOOL_REGISTRY) {
      const keys = agent.tools.map((t) => t.toolKey);
      expect(new Set(keys).size, agent.key).toBe(keys.length);
    }
  });

  it("every tool defaults ON and is toggleable (owner opts OUT, not in)", () => {
    for (const agent of AGENT_TOOL_REGISTRY) {
      for (const tool of agent.tools) {
        expect(tool.defaultEnabled, `${agent.key}.${tool.toolKey}`).toBe(true);
        expect(tool.configurable, `${agent.key}.${tool.toolKey}`).toBe(true);
      }
    }
  });

  it("dashboard declares the full side-effect toolset (email, sms, memory)", () => {
    expect(findAgentToolDefinition("dashboard", "send_email")?.tool.defaultEnabled).toBe(true);
    expect(findAgentToolDefinition("dashboard", "send_sms")?.tool.defaultEnabled).toBe(true);
    expect(findAgentToolDefinition("dashboard", "memory_capture")?.tool.defaultEnabled).toBe(true);
  });

  it("findAgentToolDefinition returns null for unknown keys", () => {
    expect(findAgentToolDefinition("dashboard", "nope")).toBeNull();
    expect(findAgentToolDefinition("nope", "send_email")).toBeNull();
  });
});

describe("resolveAgentTools", () => {
  it("returns registry defaults when the tenant has no overrides", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: [], error: null }));
    const agents = await resolveAgentTools(BIZ);
    const dashboard = agents.find((a) => a.key === "dashboard")!;
    expect(dashboard.tools.find((t) => t.toolKey === "send_email")?.enabled).toBe(true);
    expect(dashboard.tools.find((t) => t.toolKey === "send_sms")?.enabled).toBe(true);
    expect(dashboard.tools.find((t) => t.toolKey === "memory_capture")?.enabled).toBe(true);
  });

  it("treats a null data payload (no rows) as no overrides", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: null }));
    const agents = await resolveAgentTools(BIZ);
    const dashboard = agents.find((a) => a.key === "dashboard")!;
    expect(dashboard.tools.find((t) => t.toolKey === "send_email")?.enabled).toBe(true);
  });

  it("applies overrides for configurable tools", async () => {
    supabaseStub.from.mockReturnValue(
      makeBuilder({
        data: [
          { business_id: BIZ, agent_key: "dashboard", tool_key: "send_email", enabled: false, updated_at: "now" },
          { business_id: BIZ, agent_key: "sms", tool_key: "customer_lookup_by_phone", enabled: false, updated_at: "now" }
        ],
        error: null
      })
    );
    const agents = await resolveAgentTools(BIZ);
    const dashboard = agents.find((a) => a.key === "dashboard")!;
    expect(dashboard.tools.find((t) => t.toolKey === "send_email")?.enabled).toBe(false);
    // The texting coworker's tools are enforced through /api/rowboat/tool-call
    // so their toggles are honored too.
    const sms = agents.find((a) => a.key === "sms")!;
    expect(sms.tools.find((t) => t.toolKey === "customer_lookup_by_phone")?.enabled).toBe(false);
  });

  it("ignores stale rows for tools the registry no longer knows", async () => {
    supabaseStub.from.mockReturnValue(
      makeBuilder({
        data: [
          { business_id: BIZ, agent_key: "dashboard", tool_key: "removed_tool", enabled: true, updated_at: "now" }
        ],
        error: null
      })
    );
    const agents = await resolveAgentTools(BIZ);
    const dashboard = agents.find((a) => a.key === "dashboard")!;
    expect(dashboard.tools.some((t) => t.toolKey === "removed_tool")).toBe(false);
  });

  it("throws on a read error (the settings page should fail loudly, not render lies)", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: { message: "boom" } }));
    await expect(resolveAgentTools(BIZ)).rejects.toThrow(/listAgentToolSettings/);
  });
});

describe("isAgentToolEnabled", () => {
  it("returns the override row when present", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: { enabled: true }, error: null }));
    await expect(isAgentToolEnabled(BIZ, "dashboard", "send_email")).resolves.toBe(true);
  });

  it("returns the registry default when no row exists", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: null }));
    await expect(isAgentToolEnabled(BIZ, "dashboard", "send_email")).resolves.toBe(true);
    await expect(isAgentToolEnabled(BIZ, "voice", "send_follow_up_email")).resolves.toBe(true);
  });

  it("honors an explicit OFF override", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: { enabled: false }, error: null }));
    await expect(isAgentToolEnabled(BIZ, "dashboard", "send_sms")).resolves.toBe(false);
  });

  it("fails closed for unknown tools", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: { enabled: true }, error: null }));
    await expect(isAgentToolEnabled(BIZ, "dashboard", "made_up")).resolves.toBe(false);
  });

  it("resolves read errors to the registry default (DB blip must not flip behavior)", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: { message: "boom" } }));
    // Every tool defaults ON → a transient read error keeps it usable
    // rather than silently disabling a live surface.
    await expect(isAgentToolEnabled(BIZ, "dashboard", "send_email")).resolves.toBe(true);
    await expect(isAgentToolEnabled(BIZ, "voice", "send_follow_up_email")).resolves.toBe(true);
  });
});

describe("upsertAgentToolSetting", () => {
  it("upserts on the composite key and returns the row", async () => {
    const row = {
      business_id: BIZ,
      agent_key: "dashboard",
      tool_key: "send_email",
      enabled: true,
      updated_at: "now"
    };
    const builder = makeBuilder({ data: row, error: null });
    supabaseStub.from.mockReturnValue(builder);
    const out = await upsertAgentToolSetting({
      businessId: BIZ,
      agentKey: "dashboard",
      toolKey: "send_email",
      enabled: true
    });
    expect(out).toEqual(row);
    expect(builder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        agent_key: "dashboard",
        tool_key: "send_email",
        enabled: true
      }),
      { onConflict: "business_id,agent_key,tool_key" }
    );
  });

  it("throws on a write error", async () => {
    supabaseStub.from.mockReturnValue(makeBuilder({ data: null, error: { message: "nope" } }));
    await expect(
      upsertAgentToolSetting({ businessId: BIZ, agentKey: "dashboard", toolKey: "send_email", enabled: true })
    ).rejects.toThrow(/upsertAgentToolSetting/);
  });
});
