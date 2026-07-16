/**
 * Stop-on-response (GHL "stop on response" / FUB "pause on reply").
 *
 * When a lead texts back, every pending run of a flow whose
 * `options.stopOnResponse` is true is CANCELED for that lead — the whole
 * point of the setting is "once they answer, stop the scheduled follow-ups".
 * Mirrors goal_events.ts in shape and guarantees:
 *
 *   - only the machine-parked states are touched (queued — including
 *     sleep/quiet-hour deferrals — awaiting_reply, awaiting_call); runs
 *     parked on a HUMAN (awaiting_approval / awaiting_agent) are left alone;
 *   - the run whose wait_for_reply just CONSUMED this reply is exempt
 *     (`excludeRunIds`): the flow authored that wait, so the reply must flow
 *     through its branch logic, not cancel it;
 *   - test runs are never touched (a real reply must not eat a dry run);
 *   - revision-gated writes: losing a race to a claim/resume means the run
 *     moved on and this stop no longer applies;
 *   - best-effort everywhere: a failure here never breaks the inbound path.
 *
 * The cancel mirrors the owner "Stop this run" shape (`status: canceled`,
 * `context.canceled` audit entry) so the runs page renders it natively.
 *
 * Author-time contradiction (stopOnResponse + a "replied" goal) is rejected
 * by validateDefinitionSemantics, so the two reply reactions never compete
 * on one flow.
 */
import { isTestModeTrigger } from "./test_mode.ts";

/** `context.canceled.by` marker for a stop-on-response cancel. */
export const STOP_ON_RESPONSE_CANCELED_BY = "stop_on_response";

/** Run statuses a response stop may cancel (never the human-parked ones). */
const STOPPABLE_STATUSES = ["queued", "awaiting_reply", "awaiting_call"] as const;

/** Most runs one reply will stop per lead (same bound as the goal jumps). */
const MAX_RUNS_PER_EVENT = 25;

// Minimal structural client (matches the _shared convention): only the query
// shapes this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type ResponseStopResult = {
  /** Runs canceled because their flow stops on response. */
  stoppedRuns: number;
};

const NOOP: ResponseStopResult = { stoppedRuns: 0 };

type CandidateRun = {
  id: string;
  flow_id: string;
  status: string;
  context: Record<string, unknown> | null;
  revision: number;
};

/**
 * Cancel every pending stop-on-response run for this lead. Never throws; a
 * failure on one run never blocks the others.
 */
export async function stopRunsOnResponse(
  supabase: AnyClient,
  businessId: string,
  leadE164: string,
  excludeRunIds: string[] = []
): Promise<ResponseStopResult> {
  if (!leadE164) return NOOP;
  try {
    // The lead's pending runs, matched by the same identity keys the goal
    // jumps use: the triggering sender, the extracted lead phone, or the
    // number a wait/call is parked on.
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, flow_id, status, context, revision")
      .eq("business_id", businessId)
      .in("status", [...STOPPABLE_STATUSES])
      .or(
        `context->trigger->>from.eq.${leadE164},context->vars->>lead_phone.eq.${leadE164},context->waiting_reply->>from.eq.${leadE164},context->waiting_call->>to.eq.${leadE164}`
      )
      .limit(MAX_RUNS_PER_EVENT);
    if (error) {
      console.error("response_stop: run lookup", error);
      return NOOP;
    }
    const runs = ((data ?? []) as CandidateRun[]).filter(
      (r) =>
        !excludeRunIds.includes(r.id) &&
        !isTestModeTrigger(r.context?.trigger as Record<string, unknown> | undefined)
    );
    if (runs.length === 0) return NOOP;

    const stopFlowIds = await loadStopOnResponseFlowIds(supabase, [
      ...new Set(runs.map((r) => r.flow_id))
    ]);
    if (stopFlowIds.size === 0) return NOOP;

    let stopped = 0;
    for (const run of runs) {
      if (!stopFlowIds.has(run.flow_id)) continue;
      if (await cancelRun(supabase, run)) stopped += 1;
    }
    return { stoppedRuns: stopped };
  } catch (e) {
    console.error("stopRunsOnResponse", e);
    return NOOP;
  }
}

/** Ids of the given flows whose options.stopOnResponse is true (enabled only). */
async function loadStopOnResponseFlowIds(
  supabase: AnyClient,
  flowIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await supabase
    .from("ai_flows")
    .select("id, definition")
    .in("id", flowIds)
    .eq("enabled", true);
  if (error) {
    console.error("response_stop: flow lookup", error);
    return out;
  }
  for (const row of (data ?? []) as Array<{ id: string; definition?: unknown }>) {
    const def = row.definition as { options?: { stopOnResponse?: unknown } } | null;
    if (def?.options?.stopOnResponse === true) out.add(row.id);
  }
  return out;
}

/**
 * Cancel one run with the owner-stop shape. Returns whether the cancel
 * landed (false = revision race lost or a write failure).
 */
async function cancelRun(supabase: AnyClient, run: CandidateRun): Promise<boolean> {
  const nextContext = {
    ...(run.context ?? {}),
    canceled: {
      by: STOP_ON_RESPONSE_CANCELED_BY,
      at: new Date().toISOString(),
      from_status: run.status
    }
  };
  // Optimistic concurrency: gate on the revision we read (trigger-bumped on
  // every update) so a concurrent claim/resume/timeout wins cleanly.
  const { data: updated, error: updErr } = await supabase
    .from("ai_flow_runs")
    .update({
      status: "canceled",
      context: nextContext,
      claimed_at: null,
      respond_by_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .in("status", [...STOPPABLE_STATUSES])
    .select("id");
  if (updErr) {
    console.error("response_stop: run cancel", updErr);
    return false;
  }
  return ((updated ?? []) as unknown[]).length > 0;
}
