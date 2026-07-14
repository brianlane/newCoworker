/**
 * Agents — DB access.
 *
 * `business_agents` holds the reusable task templates (name + instructions +
 * output format); `agent_runs` holds every execution with its input binding
 * and produced artifact. Both tables are service-role-only (RLS on, no
 * policies) — every access flows through the Next.js server after its own
 * auth checks, matching the business_documents posture.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AgentOutputFormat } from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessAgentRow = {
  id: string;
  business_id: string;
  name: string;
  instructions: string;
  output_format: AgentOutputFormat;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentRunStatus = "running" | "succeeded" | "failed";
export type AgentRunSource = "manual" | "flow";

export type AgentRunRow = {
  id: string;
  agent_id: string;
  business_id: string;
  status: AgentRunStatus;
  source: AgentRunSource;
  flow_run_id: string | null;
  input_document_id: string | null;
  input_filename: string;
  input_mime_type: string;
  input_storage_path: string | null;
  output_md: string;
  output_filename: string;
  output_mime_type: string;
  error_detail: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  completed_at: string | null;
};

export async function listBusinessAgents(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessAgentRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_agents")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listBusinessAgents: ${error.message}`);
  return (data ?? []) as BusinessAgentRow[];
}

export async function getBusinessAgent(
  businessId: string,
  agentId: string,
  client?: SupabaseClient
): Promise<BusinessAgentRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_agents")
    .select()
    .eq("business_id", businessId)
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error(`getBusinessAgent: ${error.message}`);
  return (data as BusinessAgentRow | null) ?? null;
}

export async function countBusinessAgents(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("business_agents")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId);
  if (error) throw new Error(`countBusinessAgents: ${error.message}`);
  return count ?? 0;
}

export async function insertBusinessAgent(
  row: Pick<BusinessAgentRow, "business_id" | "name" | "instructions" | "output_format">,
  client?: SupabaseClient
): Promise<BusinessAgentRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_agents")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertBusinessAgent: ${error.message}`);
  return data as BusinessAgentRow;
}

export type BusinessAgentPatch = Partial<
  Pick<BusinessAgentRow, "name" | "instructions" | "output_format" | "enabled">
>;

export async function patchBusinessAgent(
  businessId: string,
  agentId: string,
  patch: BusinessAgentPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_agents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", agentId);
  if (error) throw new Error(`patchBusinessAgent: ${error.message}`);
}

export async function deleteBusinessAgent(
  businessId: string,
  agentId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("business_agents")
    .delete()
    .eq("business_id", businessId)
    .eq("id", agentId);
  if (error) throw new Error(`deleteBusinessAgent: ${error.message}`);
}

export async function insertAgentRun(
  row: Pick<AgentRunRow, "id" | "agent_id" | "business_id"> &
    Partial<
      Pick<
        AgentRunRow,
        | "source"
        | "flow_run_id"
        | "input_document_id"
        | "input_filename"
        | "input_mime_type"
        | "input_storage_path"
      >
    >,
  client?: SupabaseClient
): Promise<AgentRunRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_runs")
    .insert({ ...row })
    .select()
    .single();
  if (error) throw new Error(`insertAgentRun: ${error.message}`);
  return data as AgentRunRow;
}

export type AgentRunPatch = Partial<
  Pick<
    AgentRunRow,
    | "status"
    | "output_md"
    | "output_filename"
    | "output_mime_type"
    | "error_detail"
    | "prompt_tokens"
    | "output_tokens"
    | "completed_at"
  >
>;

export async function patchAgentRun(
  businessId: string,
  runId: string,
  patch: AgentRunPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("agent_runs")
    .update({ ...patch })
    .eq("business_id", businessId)
    .eq("id", runId);
  if (error) throw new Error(`patchAgentRun: ${error.message}`);
}

export async function getAgentRun(
  businessId: string,
  runId: string,
  client?: SupabaseClient
): Promise<AgentRunRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_runs")
    .select()
    .eq("business_id", businessId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`getAgentRun: ${error.message}`);
  return (data as AgentRunRow | null) ?? null;
}

/**
 * Storage paths of every archived run input for an agent — collected before
 * an agent delete so the cascade doesn't orphan objects in the bucket.
 */
export async function listAgentRunInputPaths(
  businessId: string,
  agentId: string,
  client?: SupabaseClient
): Promise<string[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_runs")
    .select("input_storage_path")
    .eq("business_id", businessId)
    .eq("agent_id", agentId)
    .not("input_storage_path", "is", null);
  if (error) throw new Error(`listAgentRunInputPaths: ${error.message}`);
  return ((data ?? []) as Array<{ input_storage_path: string | null }>)
    .map((r) => r.input_storage_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

export async function listAgentRuns(
  businessId: string,
  agentId: string,
  limit = 20,
  client?: SupabaseClient
): Promise<AgentRunRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("agent_runs")
    .select()
    .eq("business_id", businessId)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listAgentRuns: ${error.message}`);
  return (data ?? []) as AgentRunRow[];
}
