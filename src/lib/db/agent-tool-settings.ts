/**
 * Read/write helpers for `agent_tool_settings` — the owner's per-tool
 * overrides on top of the code registry in src/lib/agent-tools/registry.ts.
 *
 * Access is service-role only (table has no owner-facing RLS policies); all
 * callers MUST gate on requireOwner() / the Rowboat gateway token before
 * invoking — same trust model as dashboard-chat-jobs.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  AGENT_TOOL_REGISTRY,
  findAgentToolDefinition,
  type AgentDefinition,
  type AgentKey,
  type AgentToolDefinition
} from "@/lib/agent-tools/registry";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type AgentToolSettingRow = {
  business_id: string;
  agent_key: string;
  tool_key: string;
  enabled: boolean;
  updated_at: string;
};

export type ResolvedAgentTool = AgentToolDefinition & { enabled: boolean };
export type ResolvedAgent = Omit<AgentDefinition, "tools"> & {
  tools: ResolvedAgentTool[];
};

export async function listAgentToolSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<AgentToolSettingRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_tool_settings")
    .select("business_id, agent_key, tool_key, enabled, updated_at")
    .eq("business_id", businessId);
  if (error) throw new Error(`listAgentToolSettings: ${error.message}`);
  return (data ?? []) as AgentToolSettingRow[];
}

/**
 * Registry merged with the tenant's overrides — what the Settings page
 * renders. Rows that don't match a registry entry are ignored (stale rows
 * from a removed tool must not invent UI entries).
 */
export async function resolveAgentTools(
  businessId: string,
  client?: SupabaseClient
): Promise<ResolvedAgent[]> {
  const rows = await listAgentToolSettings(businessId, client);
  const overrides = new Map(rows.map((r) => [`${r.agent_key}\u0000${r.tool_key}`, r.enabled]));
  return AGENT_TOOL_REGISTRY.map((agent) => ({
    key: agent.key,
    label: agent.label,
    description: agent.description,
    tools: agent.tools.map((tool) => {
      const override = overrides.get(`${agent.key}\u0000${tool.toolKey}`);
      return {
        ...tool,
        // Non-configurable tools always render their default — a stale row
        // (e.g. written before a tool became display-only) must not lie.
        enabled: tool.configurable && override !== undefined ? override : tool.defaultEnabled
      };
    })
  }));
}

/**
 * Effective enabled state for one (agent, tool). Unknown keys resolve to
 * `false` (a chokepoint asking about a tool the registry doesn't know must
 * fail closed). Read errors resolve to the registry default so a transient
 * DB blip can't flip behavior away from what the owner expects: tools that
 * default ON (voice) stay usable mid-call, tools that default OFF
 * (dashboard email) stay off.
 */
export async function isAgentToolEnabled(
  businessId: string,
  agentKey: AgentKey,
  toolKey: string,
  client?: SupabaseClient
): Promise<boolean> {
  const def = findAgentToolDefinition(agentKey, toolKey);
  if (!def) return false;
  if (!def.tool.configurable) return def.tool.defaultEnabled;
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("agent_tool_settings")
      .select("enabled")
      .eq("business_id", businessId)
      .eq("agent_key", agentKey)
      .eq("tool_key", toolKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data && typeof data.enabled === "boolean") return data.enabled;
    return def.tool.defaultEnabled;
  } catch {
    return def.tool.defaultEnabled;
  }
}

export async function upsertAgentToolSetting(
  args: { businessId: string; agentKey: AgentKey; toolKey: string; enabled: boolean },
  client?: SupabaseClient
): Promise<AgentToolSettingRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_tool_settings")
    .upsert(
      {
        business_id: args.businessId,
        agent_key: args.agentKey,
        tool_key: args.toolKey,
        enabled: args.enabled,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,agent_key,tool_key" }
    )
    .select("business_id, agent_key, tool_key, enabled, updated_at")
    .single();
  if (error) throw new Error(`upsertAgentToolSetting: ${error.message}`);
  return data as AgentToolSettingRow;
}
