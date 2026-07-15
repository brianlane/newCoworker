/**
 * Agent tools: CRUD over the business's reusable attachment→output task
 * templates (name + instructions + output format). Creation is tier-capped
 * exactly like the dashboard route (agentLimitForTier), and everything is
 * gated on `manage_aiflows` — agents are automation definitions, same
 * trust level as flows.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  AGENT_NAME_MAX_CHARS,
  agentLimitForTier
} from "@/lib/agents/core";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe("Business the agents belong to. Optional when the account has exactly one business.");

export const listAgentsTool = defineMcpTool({
  name: "list_agents",
  description:
    "List the business's agents — reusable document-processing task templates (instructions run against uploaded files, manually or from run_agent flow steps).",
  schema: { business_id: businessIdField },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const { listBusinessAgents } = await import("@/lib/agents/db");
    const agents = await listBusinessAgents(businessId);
    return {
      agents: agents.map((a) => ({
        agent_id: a.id,
        name: a.name,
        instructions: a.instructions,
        output_format: a.output_format,
        enabled: a.enabled,
        updated_at: a.updated_at
      }))
    };
  }
});

export const createAgentTool = defineMcpTool({
  name: "create_agent",
  description:
    "Create a reusable agent: a named instruction template the business runs against documents (e.g. 'extract line items from invoices as a table'). Agent counts are capped per plan tier.",
  schema: {
    business_id: businessIdField,
    name: z.string().trim().min(1).max(AGENT_NAME_MAX_CHARS),
    instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX_CHARS),
    output_format: z.enum(["markdown", "same_as_input"]).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");

    const { getBusiness } = await import("@/lib/db/businesses");
    const { countBusinessAgents, insertBusinessAgent } = await import("@/lib/agents/db");
    const business = await getBusiness(businessId);
    const limit = agentLimitForTier(business?.tier);
    const count = await countBusinessAgents(businessId);
    if (count >= limit) {
      throw new McpToolError(
        `Agent limit reached (${limit} on this plan) — delete an unused agent first.`
      );
    }

    const agent = await insertBusinessAgent({
      business_id: businessId,
      name: args.name,
      instructions: args.instructions,
      output_format: args.output_format ?? "markdown"
    });
    return { created: true, agent_id: agent.id, name: agent.name };
  }
});

export const updateAgentTool = defineMcpTool({
  name: "update_agent",
  description: "Update an agent's name, instructions, output format, or enabled state.",
  schema: {
    business_id: businessIdField,
    agent_id: z.string().uuid(),
    name: z.string().trim().min(1).max(AGENT_NAME_MAX_CHARS).optional(),
    instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX_CHARS).optional(),
    output_format: z.enum(["markdown", "same_as_input"]).optional(),
    enabled: z.boolean().optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    if (
      args.name === undefined &&
      args.instructions === undefined &&
      args.output_format === undefined &&
      args.enabled === undefined
    ) {
      throw new McpToolError(
        "Nothing to update — pass name, instructions, output_format, and/or enabled."
      );
    }
    const { getBusinessAgent, patchBusinessAgent } = await import("@/lib/agents/db");
    const existing = await getBusinessAgent(businessId, args.agent_id);
    if (!existing) throw new McpToolError("Agent not found.");
    await patchBusinessAgent(businessId, args.agent_id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
      ...(args.output_format !== undefined ? { output_format: args.output_format } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {})
    });
    return { updated: true, agent_id: args.agent_id };
  }
});

export const deleteAgentTool = defineMcpTool({
  name: "delete_agent",
  description: "Delete an agent (its past run history is removed with it).",
  schema: {
    business_id: businessIdField,
    agent_id: z.string().uuid()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const { getBusinessAgent, deleteBusinessAgent } = await import("@/lib/agents/db");
    const existing = await getBusinessAgent(businessId, args.agent_id);
    if (!existing) throw new McpToolError("Agent not found.");
    await deleteBusinessAgent(businessId, args.agent_id);
    return { deleted: true, agent_id: args.agent_id };
  }
});

export const agentTools = [listAgentsTool, createAgentTool, updateAgentTool, deleteAgentTool];
