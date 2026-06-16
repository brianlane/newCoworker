/**
 * AiFlows persistence (Next.js / service-role side).
 *
 * The only app-code writer of `ai_flows` and the owner-facing reader of
 * `ai_flow_runs` / `ai_flow_run_steps` (the async ai-flow-worker writes runs via
 * the service role from the edge runtime). All definition writes go through
 * `parseAiFlowDefinition` so a malformed automation can never be persisted.
 *
 * Schema: supabase/migrations/20260608000000_ai_flows.sql.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  type AiFlowDefinition,
  parseAiFlowDefinition
} from "@/lib/ai-flows/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Use the caller-supplied client or lazily create a service-role one. */
async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

export const AI_FLOW_NAME_MAX = 120;

export type AiFlowRow = {
  id: string;
  business_id: string;
  name: string;
  enabled: boolean;
  definition: AiFlowDefinition;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AiFlowRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_agent"
  | "done"
  | "failed"
  | "canceled";

export type AiFlowRunRow = {
  id: string;
  flow_id: string;
  business_id: string;
  status: AiFlowRunStatus;
  context: Record<string, unknown>;
  current_step: number;
  /** Total worker claims, including benign re-claims (escalation/resume/defer). */
  attempt_count: number;
  /** Transient-ERROR retries only — what dead-lettering and the UI key off. */
  error_retry_count: number;
  /** Quiet-hour deferral: the claim RPC skips the run until this passes. */
  earliest_claim_at: string | null;
  last_error: string | null;
  claimed_at: string | null;
  dedupe_key: string | null;
  awaiting_agent_e164: string | null;
  respond_by_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AiFlowRunStepRow = {
  id: string;
  run_id: string;
  business_id: string;
  step_index: number;
  step_type: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const FLOW_COLS =
  "id,business_id,name,enabled,definition,created_by,created_at,updated_at";
const RUN_COLS =
  "id,flow_id,business_id,status,context,current_step,attempt_count,error_retry_count,earliest_claim_at,last_error,claimed_at,dedupe_key,awaiting_agent_e164,respond_by_at,created_at,updated_at";
const STEP_COLS =
  "id,run_id,business_id,step_index,step_type,status,result,error,created_at,updated_at";

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > AI_FLOW_NAME_MAX) {
    throw new Error(`ai_flow name must be 1-${AI_FLOW_NAME_MAX} characters`);
  }
  return trimmed;
}

export async function listAiFlows(
  businessId: string,
  client?: SupabaseClient
): Promise<AiFlowRow[]> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flows")
    .select(FLOW_COLS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listAiFlows: ${error.message}`);
  return (data ?? []) as AiFlowRow[];
}

export async function getAiFlow(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<AiFlowRow | null> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flows")
    .select(FLOW_COLS)
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getAiFlow: ${error.message}`);
  return (data as AiFlowRow | null) ?? null;
}

export type CreateAiFlowInput = {
  businessId: string;
  name: string;
  enabled?: boolean;
  definition: unknown;
  createdBy?: string | null;
};

export async function createAiFlow(
  input: CreateAiFlowInput,
  client?: SupabaseClient
): Promise<AiFlowRow> {
  const name = normalizeName(input.name);
  const definition = parseAiFlowDefinition(input.definition);
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flows")
    .insert({
      business_id: input.businessId,
      name,
      // New flows go live on creation unless the caller opts out (e.g. the
      // "duplicate" path passes enabled:false to avoid two identical flows
      // firing on the same trigger). Matches the column default.
      enabled: input.enabled ?? true,
      definition,
      created_by: input.createdBy ?? null
    })
    .select(FLOW_COLS)
    .single();
  if (error) throw new Error(`createAiFlow: ${error.message}`);
  return data as AiFlowRow;
}

export type UpdateAiFlowInput = {
  businessId: string;
  id: string;
  name?: string;
  enabled?: boolean;
  definition?: unknown;
};

export async function updateAiFlow(
  input: UpdateAiFlowInput,
  client?: SupabaseClient
): Promise<AiFlowRow> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.definition !== undefined) {
    patch.definition = parseAiFlowDefinition(input.definition);
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("updateAiFlow: nothing to update");
  }
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flows")
    .update(patch)
    .eq("business_id", input.businessId)
    .eq("id", input.id)
    .select(FLOW_COLS)
    .single();
  if (error) throw new Error(`updateAiFlow: ${error.message}`);
  return data as AiFlowRow;
}

export async function deleteAiFlow(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveDb(client);
  const { error } = await db
    .from("ai_flows")
    .delete()
    .eq("business_id", businessId)
    .eq("id", id);
  if (error) throw new Error(`deleteAiFlow: ${error.message}`);
}

export type EnqueueAiFlowRunInput = {
  businessId: string;
  flowId: string;
  /** Becomes the run's `context.trigger` (what {{trigger.x}} renders from). */
  trigger: Record<string, unknown>;
  /** Exactly-once key per (flow, dedupeKey); null skips deduplication. */
  dedupeKey?: string | null;
};

/**
 * Insert a queued run for the worker to claim — the Node-side counterpart of
 * the Telnyx webhook's enqueue (manual "Run now", inbound-email triggers).
 * Returns the row, or null when `dedupeKey` was already enqueued for this
 * flow (unique-violation 23505 — the benign "another poller tick got here
 * first" outcome).
 */
export async function enqueueAiFlowRun(
  input: EnqueueAiFlowRunInput,
  client?: SupabaseClient
): Promise<AiFlowRunRow | null> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: input.flowId,
      business_id: input.businessId,
      status: "queued",
      context: { trigger: input.trigger },
      current_step: 0,
      dedupe_key: input.dedupeKey ?? null
    })
    .select(RUN_COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw new Error(`enqueueAiFlowRun: ${error.message}`);
  }
  return data as AiFlowRunRow;
}

export type ListRunsOptions = {
  flowId?: string;
  status?: AiFlowRunStatus;
  limit?: number;
};

export async function listAiFlowRuns(
  businessId: string,
  options: ListRunsOptions = {},
  client?: SupabaseClient
): Promise<AiFlowRunRow[]> {
  const db = await resolveDb(client);
  let query = db
    .from("ai_flow_runs")
    .select(RUN_COLS)
    .eq("business_id", businessId);
  if (options.flowId) query = query.eq("flow_id", options.flowId);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(options.limit ?? 50, 200)));
  if (error) throw new Error(`listAiFlowRuns: ${error.message}`);
  return (data ?? []) as AiFlowRunRow[];
}

export async function getAiFlowRun(
  businessId: string,
  runId: string,
  client?: SupabaseClient
): Promise<AiFlowRunRow | null> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flow_runs")
    .select(RUN_COLS)
    .eq("business_id", businessId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`getAiFlowRun: ${error.message}`);
  return (data as AiFlowRunRow | null) ?? null;
}

export async function listAiFlowRunSteps(
  businessId: string,
  runId: string,
  client?: SupabaseClient
): Promise<AiFlowRunStepRow[]> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("ai_flow_run_steps")
    .select(STEP_COLS)
    .eq("business_id", businessId)
    .eq("run_id", runId)
    .order("step_index", { ascending: true });
  if (error) throw new Error(`listAiFlowRunSteps: ${error.message}`);
  return (data ?? []) as AiFlowRunStepRow[];
}

export type ApprovalDecision = "approve" | "skip" | "bypass_quiet_hours" | "deny";

/**
 * Resolve an `awaiting_approval` run.
 *   - approve → back to `queued`; the worker resumes at `current_step`.
 *   - skip    → back to `queued`; the worker skips the step the gate guards
 *               (the one directly after it) and the rest of the flow continues.
 *   - bypass_quiet_hours → back to `queued`; approve AND lift quiet-hours
 *               deferral from every remaining send_sms step in this run.
 *   - deny    → `canceled`; the whole workflow stops (always the LAST option
 *               wherever the choices are numbered).
 * The decision (+ optional note) is merged into `context.approval` for the
 * audit trail. Throws if the run is not currently awaiting approval (already
 * decided / wrong tenant / missing).
 */
export async function decideAiFlowApproval(
  args: {
    businessId: string;
    runId: string;
    decision: ApprovalDecision;
    decidedBy?: string | null;
    note?: string;
  },
  client?: SupabaseClient
): Promise<AiFlowRunRow> {
  const db = await resolveDb(client);
  const current = await getAiFlowRun(args.businessId, args.runId, db);
  if (!current) {
    throw new Error("decideAiFlowApproval: run not found");
  }
  if (current.status !== "awaiting_approval") {
    throw new Error("decideAiFlowApproval: run is not awaiting approval");
  }
  const nextStatus: AiFlowRunStatus = args.decision === "deny" ? "canceled" : "queued";
  const context = {
    ...current.context,
    approval: {
      decision: args.decision,
      decided_by: args.decidedBy ?? null,
      note: args.note ?? null,
      decided_at: new Date().toISOString()
    }
  };
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({ status: nextStatus, context, claimed_at: null })
    .eq("business_id", args.businessId)
    .eq("id", args.runId)
    .eq("status", "awaiting_approval")
    .select(RUN_COLS)
    .single();
  if (error) throw new Error(`decideAiFlowApproval: ${error.message}`);
  return data as AiFlowRunRow;
}
