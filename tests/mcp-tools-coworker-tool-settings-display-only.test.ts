/**
 * Display-only (`configurable: false`) behavior of
 * update_coworker_tool_settings. The live registry marks every tool
 * configurable today, so this branch runs against a mocked registry, same
 * approach as tests/agent-tool-settings-display-only.test.ts, and for the
 * same reason: the mechanism must keep working for any future tool we
 * surface for visibility without a platform chokepoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async () => "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/db/agent-tool-settings", () => ({ upsertAgentToolSetting: vi.fn() }));
vi.mock("@/lib/agent-tools/registry", () => {
  const REGISTRY = [
    {
      key: "dashboard",
      label: "Dashboard chat coworker",
      description: "test",
      tools: [
        {
          toolKey: "mixed_tool",
          label: "Mixed tool",
          description: "Configurable here.",
          defaultEnabled: true,
          configurable: true
        }
      ]
    },
    {
      key: "sms",
      label: "Texting coworker",
      description: "test",
      tools: [
        {
          toolKey: "mixed_tool",
          label: "Mixed tool",
          description: "Display-only here.",
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

import { updateCoworkerToolSettingsTool } from "@/lib/mcp/tools/coworker-tool-settings";
import { upsertAgentToolSetting } from "@/lib/db/agent-tool-settings";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertAgentToolSetting).mockResolvedValue({
    business_id: "biz-1",
    agent_key: "dashboard",
    tool_key: "mixed_tool",
    enabled: false,
    updated_at: "now"
  } as never);
});

describe("display-only surfaces", () => {
  it("reports platform_managed for the display-only surface and still sets the other", async () => {
    const result = (await runTool(
      updateCoworkerToolSettingsTool,
      { tool_key: "mixed_tool", agents: ["dashboard", "sms"], enabled: false },
      AUTH
    )) as { results: Array<{ agent: string; status: string }> };
    expect(result.results).toEqual([
      { agent: "dashboard", status: "set" },
      { agent: "sms", status: "platform_managed" }
    ]);
    expect(vi.mocked(upsertAgentToolSetting)).toHaveBeenCalledTimes(1);
  });

  it("refuses when the only listed surface is display-only, naming where it lives", async () => {
    await expect(
      runTool(
        updateCoworkerToolSettingsTool,
        { tool_key: "mixed_tool", agents: ["sms"], enabled: false },
        AUTH
      )
    ).rejects.toThrow(/not configurable on sms/);
    expect(upsertAgentToolSetting).not.toHaveBeenCalled();
  });

  it("an unknown key on a surface the registry does not even list yields an empty key list", async () => {
    // The mocked registry has no "voice" surface at all: the unknown-key
    // refusal must still form, with no keys to suggest.
    await expect(
      runTool(
        updateCoworkerToolSettingsTool,
        { tool_key: "nope", agents: ["voice"], enabled: false },
        AUTH
      )
    ).rejects.toThrow(/Valid keys on voice: \./);
  });
});
