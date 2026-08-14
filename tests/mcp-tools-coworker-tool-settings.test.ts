import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/db/agent-tool-settings", () => ({ upsertAgentToolSetting: vi.fn() }));

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import { updateCoworkerToolSettingsTool } from "@/lib/mcp/tools/coworker-tool-settings";
import { upsertAgentToolSetting } from "@/lib/db/agent-tool-settings";
import { findAgentToolDefinition } from "@/lib/agent-tools/registry";
import { runTool } from "./helpers/run-mcp-tool";

/**
 * update_coworker_tool_settings: the category-D one-shot class made
 * self-serve ("stop the coworker canceling bookings over text"). The Amy
 * lesson is the contract: a policy reaches ONLY the surfaces written, so
 * the tool takes an explicit surface list and reports each outcome.
 */

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(upsertAgentToolSetting).mockImplementation(
    async (args) =>
      ({
        business_id: args.businessId,
        agent_key: args.agentKey,
        tool_key: args.toolKey,
        enabled: args.enabled,
        updated_at: "now"
      }) as never
  );
});

describe("update_coworker_tool_settings (MCP)", () => {
  it("writes one row per listed surface and reports each outcome", async () => {
    const result = (await runTool(
      updateCoworkerToolSettingsTool,
      { tool_key: "calendar_cancel_appointment", agents: ["sms", "email"], enabled: false },
      AUTH
    )) as { results: Array<{ agent: string; status: string }>; note: string };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(vi.mocked(upsertAgentToolSetting).mock.calls.map((c) => c[0])).toEqual([
      {
        businessId: "biz-1",
        agentKey: "sms",
        toolKey: "calendar_cancel_appointment",
        enabled: false
      },
      {
        businessId: "biz-1",
        agentKey: "email",
        toolKey: "calendar_cancel_appointment",
        enabled: false
      }
    ]);
    expect(result.results).toEqual([
      { agent: "sms", status: "set" },
      { agent: "email", status: "set" }
    ]);
    expect(result.note).toContain("only the listed channels");
  });

  it("reports surfaces that do not declare the tool without failing the ones that do", async () => {
    // send_email exists on dashboard/email/slack but not on webchat.
    expect(findAgentToolDefinition("webchat", "send_email")).toBeNull();
    const result = (await runTool(
      updateCoworkerToolSettingsTool,
      { tool_key: "send_email", agents: ["dashboard", "webchat"], enabled: false },
      AUTH
    )) as { results: Array<{ agent: string; status: string }> };
    expect(result.results).toEqual([
      { agent: "dashboard", status: "set" },
      { agent: "webchat", status: "not_on_this_surface" }
    ]);
  });

  it("dedupes a repeated surface so one row is written once", async () => {
    await runTool(
      updateCoworkerToolSettingsTool,
      { tool_key: "send_email", agents: ["sms", "sms"], enabled: true },
      AUTH
    );
    expect(vi.mocked(upsertAgentToolSetting)).toHaveBeenCalledTimes(1);
  });

  it("refuses when NO listed surface accepted, naming where the tool lives", async () => {
    await expect(
      runTool(
        updateCoworkerToolSettingsTool,
        { tool_key: "send_email", agents: ["webchat"], enabled: false },
        AUTH
      )
    ).rejects.toThrow(/Surfaces that have it: .*dashboard/);
    expect(upsertAgentToolSetting).not.toHaveBeenCalled();
  });

  it("refuses an unknown tool_key with the valid keys for the first surface", async () => {
    await expect(
      runTool(
        updateCoworkerToolSettingsTool,
        { tool_key: "made_up_tool", agents: ["dashboard"], enabled: false },
        AUTH
      )
    ).rejects.toThrow(/Valid keys on dashboard: .*send_sms/);
  });

  it("a refused role check propagates before any write", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError("Your role does not allow this.")
    );
    await expect(
      runTool(
        updateCoworkerToolSettingsTool,
        { tool_key: "send_email", agents: ["sms"], enabled: false },
        AUTH
      )
    ).rejects.toThrow(/role does not allow/);
    expect(upsertAgentToolSetting).not.toHaveBeenCalled();
  });
});
