/**
 * Coworker tool-policy tool: flip a Settings → Coworker tools toggle per
 * channel, the category-D one-shot class ("the AI canceled a lead's booking
 * from a text — make sure that can't happen" = disable
 * calendar_cancel_appointment on the sms surface).
 *
 * The Amy lesson is load-bearing here: a policy set on one surface reaches
 * ONLY that surface (a missing row means the registry default, usually
 * enabled). So the tool takes an explicit list of surfaces and reports the
 * outcome per surface, instead of pretending one write covers the fleet.
 *
 * Writes go through the same helpers as the Settings page PUT route
 * (findAgentToolDefinition + upsertAgentToolSetting): unknown keys and
 * display-only tools are refused the same way, so the table never gains
 * rows the enforcement layer won't honor.
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import {
  AGENT_TOOL_REGISTRY,
  findAgentToolDefinition,
  type AgentKey
} from "@/lib/agent-tools/registry";
import { upsertAgentToolSetting } from "@/lib/db/agent-tool-settings";

const AGENT_KEYS = ["dashboard", "voice", "sms", "webchat", "email", "slack"] as const;

/** Which surfaces declare this toolKey at all — for actionable refusals. */
function surfacesDeclaring(toolKey: string): string[] {
  return AGENT_TOOL_REGISTRY.filter((agent) =>
    agent.tools.some((tool) => tool.toolKey === toolKey)
  ).map((agent) => agent.key);
}

/** The toolKey vocabulary for one surface — for unknown-key refusals. */
function toolKeysForSurface(agentKey: string): string[] {
  const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === agentKey);
  return agent ? agent.tools.map((t) => t.toolKey) : [];
}

export const updateCoworkerToolSettingsTool = defineMcpTool({
  name: "update_coworker_tool_settings",
  title: "Turn a coworker tool on or off",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: z.object({
    tool_key: z.string(),
    enabled: z.boolean(),
    results: z.array(
      z.object({
        agent: z.string(),
        status: z.enum(["set", "not_on_this_surface", "platform_managed"])
      })
    ),
    note: z.string()
  }),
  description:
    'Enable or disable one coworker tool on specific channels (surfaces): dashboard, voice, sms, webchat, email, slack. A policy applies ONLY to the channels you list, disabling appointment cancellation on sms still leaves voice able to cancel, so list every channel the owner means. Use the exact tool_key from Settings → Coworker tools (e.g. "calendar_cancel_appointment", "send_sms"); an unknown key is refused with the valid keys listed.',
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to update. Optional when the account has exactly one business."),
    tool_key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('Registry tool key, e.g. "calendar_cancel_appointment".'),
    agents: z
      .array(z.enum(AGENT_KEYS))
      .min(1)
      .max(AGENT_KEYS.length)
      .describe("The surfaces this policy applies to. List every channel the owner means."),
    enabled: z.boolean().describe("true turns the tool on; false turns it off.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");

    const agents = [...new Set(args.agents)];
    const results: Array<{
      agent: string;
      status: "set" | "not_on_this_surface" | "platform_managed";
    }> = [];
    for (const agentKey of agents) {
      const def = findAgentToolDefinition(agentKey, args.tool_key);
      if (!def) {
        results.push({ agent: agentKey, status: "not_on_this_surface" });
        continue;
      }
      if (!def.tool.configurable) {
        results.push({ agent: agentKey, status: "platform_managed" });
        continue;
      }
      await upsertAgentToolSetting({
        businessId,
        agentKey: agentKey as AgentKey,
        toolKey: args.tool_key,
        enabled: args.enabled
      });
      results.push({ agent: agentKey, status: "set" });
    }

    if (!results.some((r) => r.status === "set")) {
      const declaring = surfacesDeclaring(args.tool_key);
      throw new McpToolError(
        declaring.length > 0
          ? `"${args.tool_key}" is not configurable on ${agents.join(", ")}. Surfaces that have it: ${declaring.join(", ")}.`
          : `Unknown tool_key "${args.tool_key}". Valid keys on ${agents[0]}: ${toolKeysForSurface(agents[0]).join(", ")}.`
      );
    }

    return {
      tool_key: args.tool_key,
      enabled: args.enabled,
      results,
      note:
        "This policy covers only the listed channels; other channels keep their own setting (a missing row means the registry default)."
    };
  }
});

export const coworkerToolSettingsTools = [updateCoworkerToolSettingsTool];
