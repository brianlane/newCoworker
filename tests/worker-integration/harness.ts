/**
 * Harness for the ai-flow-worker integration suite: a REAL local Supabase
 * stack (`supabase start` — Postgres, PostgREST, RPCs, every migration) with
 * the REAL worker served by `supabase functions serve`. Tests seed rows with
 * the service-role client, tick the worker over HTTP exactly like pg_cron
 * does in production, and assert persisted state.
 *
 * This is the layer the in-process unit/e2e suites cannot reach: run
 * claiming and lease reclaim, revision bumps, wait_for_reply park/timeout
 * RPCs, sleep deferrals via earliest_claim_at, and step-row persistence.
 *
 * Required env (the CI job and local runs set these; see
 * .github/workflows/ci.yml `worker-integration`):
 *   ITEST_SUPABASE_URL        (default http://127.0.0.1:54321)
 *   ITEST_SERVICE_ROLE_KEY    (from `supabase status`)
 *   ITEST_CRON_SECRET         (must match the served worker's
 *                              INTERNAL_CRON_SECRET; default itest-cron-secret)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

export const SUPABASE_URL = (process.env.ITEST_SUPABASE_URL ?? "http://127.0.0.1:54321").replace(
  /\/$/,
  ""
);
const SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CRON_SECRET = process.env.ITEST_CRON_SECRET ?? "itest-cron-secret";
const WORKER_URL = `${SUPABASE_URL}/functions/v1/ai-flow-worker`;

export function serviceDb(): SupabaseClient {
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "ITEST_SERVICE_ROLE_KEY is not set — run `supabase status` and export the service role key."
    );
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/** One worker tick — the exact POST pg_cron makes in production. */
export async function tickWorker(): Promise<{ ok: boolean; processed: number }> {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
    body: "{}"
  });
  if (!res.ok) {
    throw new Error(`worker tick ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as { ok: boolean; processed: number };
}

export async function seedBusiness(db: SupabaseClient, name: string): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("businesses").insert({
    id,
    name,
    owner_email: `owner+${id.slice(0, 8)}@example.com`,
    tier: "standard",
    status: "online"
  });
  if (error) throw new Error(`seedBusiness: ${error.message}`);
  return id;
}

export async function seedContact(
  db: SupabaseClient,
  businessId: string,
  e164: string,
  over: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from("contacts").insert({
    business_id: businessId,
    customer_e164: e164,
    display_name: "Integration Lead",
    tags: [],
    ...over
  });
  if (error) throw new Error(`seedContact: ${error.message}`);
}

export async function createFlow(
  db: SupabaseClient,
  businessId: string,
  definition: Record<string, unknown>,
  enabled = true
): Promise<string> {
  const { data, error } = await db
    .from("ai_flows")
    .insert({ business_id: businessId, name: "Integration flow", enabled, definition })
    .select("id")
    .single();
  if (error) throw new Error(`createFlow: ${error.message}`);
  return (data as { id: string }).id;
}

export async function enqueueRun(
  db: SupabaseClient,
  flowId: string,
  businessId: string,
  trigger: Record<string, unknown>,
  vars: Record<string, unknown> = {},
  over: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: flowId,
      business_id: businessId,
      status: "queued",
      context: { trigger, vars },
      ...over
    })
    .select("id")
    .single();
  if (error) throw new Error(`enqueueRun: ${error.message}`);
  return (data as { id: string }).id;
}

export type RunRow = {
  id: string;
  status: string;
  current_step: number;
  context: {
    trigger?: Record<string, unknown>;
    vars?: Record<string, unknown>;
    waiting_reply?: Record<string, unknown> | null;
  };
  revision: number;
  earliest_claim_at: string | null;
  respond_by_at: string | null;
  last_error: string | null;
};

export async function getRun(db: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("id, status, current_step, context, revision, earliest_claim_at, respond_by_at, last_error")
    .eq("id", runId)
    .single();
  if (error) throw new Error(`getRun: ${error.message}`);
  return data as RunRow;
}

export async function getSteps(
  db: SupabaseClient,
  runId: string
): Promise<Array<{ step_index: number; step_type: string; status: string; result: unknown }>> {
  const { data, error } = await db
    .from("ai_flow_run_steps")
    .select("step_index, step_type, status, result")
    .eq("run_id", runId)
    .order("step_index");
  if (error) throw new Error(`getSteps: ${error.message}`);
  return data as Array<{ step_index: number; step_type: string; status: string; result: unknown }>;
}

export async function getContactTags(
  db: SupabaseClient,
  businessId: string,
  e164: string
): Promise<string[]> {
  const { data, error } = await db
    .from("contacts")
    .select("tags")
    .eq("business_id", businessId)
    .eq("customer_e164", e164)
    .single();
  if (error) throw new Error(`getContactTags: ${error.message}`);
  return ((data as { tags?: string[] }).tags ?? []) as string[];
}

/** Shift a run's timer columns so timeout/deferral paths run NOW. */
export async function ageRun(
  db: SupabaseClient,
  runId: string,
  patch: Partial<Record<"respond_by_at" | "earliest_claim_at" | "claimed_at", string | null>>
): Promise<void> {
  const { error } = await db.from("ai_flow_runs").update(patch).eq("id", runId);
  if (error) throw new Error(`ageRun: ${error.message}`);
}

export function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}
