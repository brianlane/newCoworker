/**
 * Re-entry gate (GHL "allow re-entry").
 *
 * When a flow's `options.allowReentry` is EXPLICITLY false, a contact who
 * already has a run of that flow — any status, including finished ones — is
 * not enrolled again. Enforced best-effort at the lead-keyed enqueue sites
 * (inbound-SMS trigger eval, contact events, the Node enqueueAiFlowRun);
 * enqueues that carry no lead identity (webhook payloads before extraction,
 * schedule/manual starts) are governed by their own dedupe keys instead.
 *
 * Deliberate semantics:
 *   - test runs never count as an enrollment (and the test-run route never
 *     calls this gate — testing must always work);
 *   - a lookup FAILURE fails OPEN (the run enqueues): a duplicate follow-up
 *     is recoverable, a silently dropped lead is not;
 *   - two perfectly concurrent enqueues may both pass (best-effort, same as
 *     drip pacing) — the flow's dedupe key still collapses true duplicates.
 */
import { isTestModeTrigger } from "./test_mode.ts";

// Minimal structural client (matches the _shared convention).
// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** True when this definition opts out of re-entry (explicit false only). */
export function flowBlocksReentry(def: unknown): boolean {
  const options = (def as { options?: { allowReentry?: unknown } } | null | undefined)?.options;
  return options?.allowReentry === false;
}

/** Cap on the prior-run scan: only non-test rows count, so read a few. */
const PRIOR_RUN_SCAN = 10;

/**
 * Does this lead already have a (non-test) run of this flow? Matched by the
 * same identity keys the goal jumps use: the triggering sender, the
 * extracted lead phone, or the number a wait was parked on. Fails OPEN
 * (false) on a lookup error.
 */
export async function hasPriorRunForLead(
  supabase: AnyClient,
  flowId: string,
  leadE164: string
): Promise<boolean> {
  if (!leadE164) return false;
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, context")
      .eq("flow_id", flowId)
      .or(
        `context->trigger->>from.eq.${leadE164},context->vars->>lead_phone.eq.${leadE164},context->waiting_reply->>from.eq.${leadE164},context->waiting_call->>to.eq.${leadE164}`
      )
      .limit(PRIOR_RUN_SCAN);
    if (error) {
      console.error("reentry: prior-run lookup", error);
      return false;
    }
    const rows = (data ?? []) as Array<{ context?: Record<string, unknown> | null }>;
    return rows.some(
      (r) => !isTestModeTrigger(r.context?.trigger as Record<string, unknown> | undefined)
    );
  } catch (e) {
    console.error("hasPriorRunForLead", e);
    return false;
  }
}

/**
 * The one call enqueue sites make: should this enqueue be SKIPPED because
 * the flow blocks re-entry and the lead was already enrolled? Reads the
 * definition first so flows with re-entry allowed (the default) pay nothing
 * beyond the property check.
 */
export async function reentryBlocked(
  supabase: AnyClient,
  flowId: string,
  def: unknown,
  leadE164: string | null | undefined
): Promise<boolean> {
  if (!flowBlocksReentry(def)) return false;
  if (!leadE164) return false;
  return hasPriorRunForLead(supabase, flowId, leadE164);
}
