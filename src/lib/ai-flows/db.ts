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
import { reentryBlocked } from "../../../supabase/functions/_shared/ai_flows/reentry";
import { isTestModeTrigger } from "../../../supabase/functions/_shared/ai_flows/test_mode";

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
  /**
   * ISO timestamp of this flow's most-recent run, or null when it has never
   * run. Computed by {@link listAiFlows} (not a stored column) so the dashboard
   * can sort flows by activity and show "last run X ago".
   */
  last_run_at?: string | null;
  /**
   * When `enabled` last flipped (stamped by the trg_ai_flows_enabled_changed
   * DB trigger only on an actual change). NULL = never toggled since
   * creation — display falls back to created_at.
   */
  enabled_changed_at?: string | null;
};

export type AiFlowRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_agent"
  | "awaiting_reply"
  | "awaiting_call"
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
  /**
   * Short-lived signed URL for the step's stored browse screenshot, when one
   * was captured (the bucket is private). Attached by the run-detail reader, not
   * a stored column. Lets the dashboard "investigate" a run by showing what each
   * browser step (or the step that failed) actually saw.
   */
  screenshot_url?: string | null;
  /**
   * Signed URL for the "before actions" screenshot — only present on a failed
   * browse_action step. Pairs with `screenshot_url` (the stuck page) to show the
   * page state going into the step vs. where it broke.
   */
  screenshot_before_url?: string | null;
  /**
   * Short-lived signed URL for the captured page source (raw HTML) paired with
   * `screenshot_url`, when one was stored. Lets the investigate view link the
   * exact markup behind a step's screenshot.
   */
  source_url?: string | null;
  /** Signed URL for the page source paired with `screenshot_before_url`. */
  source_before_url?: string | null;
};

/** Private bucket the ai-flow-worker writes browse screenshots into. */
const SCREENSHOT_BUCKET = "aiflow-screenshots";
/** Signed-URL lifetime for dashboard screenshot viewing. */
const SCREENSHOT_SIGNED_URL_TTL_S = 600;

const FLOW_COLS =
  "id,business_id,name,enabled,definition,created_by,created_at,updated_at,enabled_changed_at";
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
  const flows = (data ?? []) as AiFlowRow[];

  // Attach each flow's most-recent run time so the dashboard can sort by
  // activity (most-recently-run first). Read runs newest-first and keep the
  // first time seen per flow. A failure here must not blank the list, so on
  // error we fall back to the created_at order above.
  const lastRunByFlow = new Map<string, string>();
  const { data: runRows } = await db
    .from("ai_flow_runs")
    .select("flow_id, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  for (const r of (runRows ?? []) as Array<{ flow_id: string; created_at: string }>) {
    if (!lastRunByFlow.has(r.flow_id)) lastRunByFlow.set(r.flow_id, r.created_at);
  }
  for (const f of flows) f.last_run_at = lastRunByFlow.get(f.id) ?? null;

  // Most-recently-run first; flows that have never run sort last (by their
  // existing created_at order, since the input array is already created_at desc).
  return flows.sort((a, b) => {
    const ar = a.last_run_at;
    const br = b.last_run_at;
    if (ar && br) return ar < br ? 1 : ar > br ? -1 : 0;
    if (ar) return -1;
    if (br) return 1;
    return 0;
  });
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
  /**
   * When set, the worker's claim RPC skips the run until this ISO timestamp
   * passes (same `earliest_claim_at` mechanism quiet-hour deferrals use).
   * Lets bulk enqueues (lead-backlog import) drip runs out over time.
   */
  earliestClaimAt?: string | null;
};

/**
 * Insert a queued run for the worker to claim — the Node-side counterpart of
 * the Telnyx webhook's enqueue (manual "Run now", inbound-email triggers).
 * Returns the row, or null when `dedupeKey` was already enqueued for this
 * flow (unique-violation 23505 — the benign "another poller tick got here
 * first" outcome) or when the flow blocks re-entry and `trigger.from`
 * already has a run of it (same "already handled" outcome for callers).
 */
export async function enqueueAiFlowRun(
  input: EnqueueAiFlowRunInput,
  client?: SupabaseClient
): Promise<AiFlowRunRow | null> {
  const db = await resolveDb(client);
  // One definition read serves both flow-level enqueue gates below (re-entry
  // and drip). Best-effort: on a read failure both gates default to "no
  // gate" — losing the lead is worse than a duplicate or a burst.
  let definition: { drip?: { intervalMinutes?: number } } | null = null;
  try {
    const { data: flowRow } = await db
      .from("ai_flows")
      .select("definition")
      .eq("id", input.flowId)
      .maybeSingle();
    definition =
      (flowRow as { definition?: { drip?: { intervalMinutes?: number } } } | null)
        ?.definition ?? null;
  } catch (e) {
    console.error("enqueueAiFlowRun definition read", e);
  }

  // Re-entry gate (options.allowReentry === false): a contact who already
  // has a (non-test) run of this flow is not enrolled again. Test runs
  // bypass the gate entirely — testing must always work.
  if (!isTestModeTrigger(input.trigger) && definition) {
    const from = typeof input.trigger.from === "string" ? input.trigger.from : "";
    if (await reentryBlocked(db, input.flowId, definition, from)) return null;
  }

  // Drip pacing (definition.drip): stagger this run intervalMinutes after
  // the flow's latest already-scheduled run, so a bulk enqueue (backlog
  // import, webhook burst) trickles instead of bursting. An explicit
  // earliestClaimAt from the caller wins (the backlog import computes its
  // own spacing). Best-effort: a read failure enqueues immediately — pacing
  // is a nicety, losing the lead is not. Two perfectly concurrent enqueues
  // may land on the same slot; the spacing is approximate by design.
  let dripClaimAt: string | null = null;
  if (!input.earliestClaimAt) {
    try {
      const intervalMinutes = definition?.drip?.intervalMinutes;
      if (typeof intervalMinutes === "number" && intervalMinutes >= 1) {
        const { data: lastRow } = await db
          .from("ai_flow_runs")
          .select("earliest_claim_at")
          .eq("flow_id", input.flowId)
          .eq("status", "queued")
          .not("earliest_claim_at", "is", null)
          .order("earliest_claim_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastIso = (lastRow as { earliest_claim_at?: string | null } | null)
          ?.earliest_claim_at;
        const lastMs = lastIso ? Date.parse(lastIso) : NaN;
        const nowMs = Date.now();
        const nextMs = Number.isFinite(lastMs)
          ? Math.max(nowMs, lastMs + intervalMinutes * 60_000)
          : nowMs;
        // The FIRST dripped run goes now; each subsequent one steps out from
        // the latest scheduled slot.
        dripClaimAt = nextMs > nowMs ? new Date(nextMs).toISOString() : new Date(nowMs).toISOString();
      }
    } catch (e) {
      console.error("enqueueAiFlowRun drip", e);
    }
  }
  const earliestClaimAt = input.earliestClaimAt ?? dripClaimAt;
  const { data, error } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: input.flowId,
      business_id: input.businessId,
      status: "queued",
      context: { trigger: input.trigger },
      current_step: 0,
      dedupe_key: input.dedupeKey ?? null,
      ...(earliestClaimAt ? { earliest_claim_at: earliestClaimAt } : {})
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
  const steps = (data ?? []) as AiFlowRunStepRow[];
  return await attachScreenshotUrls(db, steps);
}

/**
 * Sign short-lived URLs for each step that stored a browse screenshot
 * (`result.screenshot_path` / `screenshot_before_path`) and/or its paired page
 * source (`result.source_path` / `source_before_path`). The bucket is private,
 * so the dashboard can only reach either via a signed URL. Best-effort: a signing
 * failure leaves the URLs undefined rather than failing the whole run-detail read.
 */
async function attachScreenshotUrls(
  db: SupabaseClient,
  steps: AiFlowRunStepRow[]
): Promise<AiFlowRunStepRow[]> {
  type PathKey =
    | "screenshot_path"
    | "screenshot_before_path"
    | "source_path"
    | "source_before_path";
  const allKeys: PathKey[] = [
    "screenshot_path",
    "screenshot_before_path",
    "source_path",
    "source_before_path"
  ];
  const pathOf = (s: AiFlowRunStepRow, key: PathKey) =>
    typeof s.result?.[key] === "string" ? (s.result[key] as string) : "";
  const paths = steps.flatMap((s) =>
    allKeys.map((k) => pathOf(s, k)).filter((p): p is string => p.length > 0)
  );
  if (paths.length === 0) return steps;
  const signedByPath = new Map<string, string>();
  const { data, error } = await db.storage
    .from(SCREENSHOT_BUCKET)
    .createSignedUrls([...new Set(paths)], SCREENSHOT_SIGNED_URL_TTL_S);
  if (!error && data) {
    for (const entry of data) {
      if (entry.path && entry.signedUrl) signedByPath.set(entry.path, entry.signedUrl);
    }
  }
  return steps.map((s) => {
    const mainUrl = signedByPath.get(pathOf(s, "screenshot_path"));
    const beforeUrl = signedByPath.get(pathOf(s, "screenshot_before_path"));
    const sourceUrl = signedByPath.get(pathOf(s, "source_path"));
    const sourceBeforeUrl = signedByPath.get(pathOf(s, "source_before_path"));
    if (!mainUrl && !beforeUrl && !sourceUrl && !sourceBeforeUrl) return s;
    return {
      ...s,
      ...(mainUrl ? { screenshot_url: mainUrl } : {}),
      ...(beforeUrl ? { screenshot_before_url: beforeUrl } : {}),
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      ...(sourceBeforeUrl ? { source_before_url: sourceBeforeUrl } : {})
    };
  });
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

/**
 * Run states an owner may STOP from the dashboard — every non-terminal state,
 * including `running`. A running run cancels COOPERATIVELY: the worker
 * re-reads the run's status at each step boundary and quits when it sees
 * `canceled` (the step already in flight completes), and every worker state
 * write is guarded with `.neq(status, canceled)` so a cancel is never
 * overwritten by a late persist. Terminal states have nothing to stop.
 */
export const CANCELABLE_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
  "awaiting_reply",
  "awaiting_call"
] as const;

/**
 * Owner "Stop this run": flip a non-terminal run to `canceled` so nothing
 * further sends. Status-guarded at the DB (the update matches only cancelable
 * states), so racing a terminal write loses cleanly — the run either cancels
 * or the caller gets a conflict to surface. Every resume path (claim RPC,
 * offer escalation, reply sweeps, inbound webhooks) filters on the waiting
 * status it owns, and the worker both checks for `canceled` at step
 * boundaries and guards its own writes, so a canceled run can never be picked
 * back up or overwritten. Who stopped it (and from which state) is recorded
 * in `context.canceled` for the audit trail.
 */
export async function cancelAiFlowRun(
  args: { businessId: string; runId: string; canceledBy?: string | null },
  client?: SupabaseClient
): Promise<AiFlowRunRow> {
  const db = await resolveDb(client);
  const current = await getAiFlowRun(args.businessId, args.runId, db);
  if (!current) {
    throw new Error("cancelAiFlowRun: run not found");
  }
  if (!(CANCELABLE_RUN_STATUSES as readonly string[]).includes(current.status)) {
    throw new Error(`cancelAiFlowRun: run is ${current.status} and cannot be stopped`);
  }
  const context = {
    ...current.context,
    canceled: {
      by: args.canceledBy ?? null,
      at: new Date().toISOString(),
      from_status: current.status
    }
  };
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({ status: "canceled", context, claimed_at: null })
    .eq("business_id", args.businessId)
    .eq("id", args.runId)
    .in("status", [...CANCELABLE_RUN_STATUSES])
    .select(RUN_COLS)
    .single();
  if (error) {
    // PGRST116 = the guarded update matched zero rows: the worker claimed the
    // run (or a duplicate cancel landed) between the pre-read and the write.
    // Same owner-facing outcome as the pre-read guard, not a server error.
    if ((error as { code?: string }).code === "PGRST116") {
      throw new Error("cancelAiFlowRun: run is no longer waiting and cannot be stopped");
    }
    throw new Error(`cancelAiFlowRun: ${error.message}`);
  }
  return data as AiFlowRunRow;
}
