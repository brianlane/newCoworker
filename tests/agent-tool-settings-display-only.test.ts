/**
 * Display-only (`configurable: false`) behavior of the settings resolver.
 *
 * The live registry currently marks every tool configurable (each one has a
 * real enforcement point), so these branches are exercised against a mocked
 * registry containing a display-only tool — the mechanism must keep working
 * for any future tool we surface for visibility without a platform
 * chokepoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data: unknown; error: { message: string } | null };

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

vi.mock("@/lib/agent-tools/registry", () => {
  const REGISTRY = [
    {
      key: "sms",
      label: "Texting coworker",
      description: "test",
      tools: [
        {
          toolKey: "platform_managed_tool",
          label: "Platform-managed tool",
          description: "Display-only.",
          defaultEnabled: true,
          configurable: false
        }
      ]
    }
  ];
  return {
    AGENT_TOOL_REGISTRY: REGISTRY,
    findAgentToolDefinition: (agentKey: string, toolKey: string) => {
      const agent = REGISTRY.find((a) => a.key === agentKey);
      const tool = agent?.tools.find((t) => t.toolKey === toolKey);
      return agent && tool ? { agent, tool } : null;
    }
  };
});

import { isAgentToolEnabled, resolveAgentTools } from "@/lib/db/agent-tool-settings";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("display-only tools", () => {
  it("resolveAgentTools renders the default and ignores stale override rows", async () => {
    supabaseStub.from.mockReturnValue(
      makeBuilder({
        data: [
          {
            business_id: BIZ,
            agent_key: "sms",
            tool_key: "platform_managed_tool",
            enabled: false,
            updated_at: "now"
          }
        ],
        error: null
      })
    );
    const agents = await resolveAgentTools(BIZ);
    // A stale row (written before the tool became display-only) must not lie.
    expect(agents[0].tools[0].enabled).toBe(true);
  });

  it("isAgentToolEnabled returns the default without reading the DB", async () => {
    await expect(isAgentToolEnabled(BIZ, "sms", "platform_managed_tool")).resolves.toBe(true);
    expect(supabaseStub.from).not.toHaveBeenCalled();
  });
});
