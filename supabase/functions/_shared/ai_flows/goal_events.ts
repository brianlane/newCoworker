/**
 * GHL-style Goal Events: external-milestone jumps for AiFlow runs.
 *
 * A `goal` step is a trunk-only checkpoint. When a watched milestone lands
 * for a lead, they text back, an appointment is booked, a tag is added, a
 * teammate claims them, every one of that lead's runs that is queued
 * (including sleep/quiet-hour deferrals), parked awaiting their reply, or
 * parked on an in-progress AI call (awaiting_call, the physical call is
 * unaffected; its outcome resume no-ops on the moved-on run)
 * fast-forwards to its first matching goal step AHEAD of the current step:
 *
 *   1. the run's `current_step` jumps to the goal's flattened index (forward
 *      only, the integer park/resume state machine is untouched);
 *   2. the skipped-over steps are recorded "skipped" (reason `goal_jump`) so
 *      run history shows exactly which follow-ups the goal short-circuited;
 *   3. the context var `__goal_<stepId>` records which event kind jumped, so
 *      the goal step's inline execution reports "reached via <event>".
 *
 * Consumers (all best-effort, a goal failure must never break the hook's
 * own path):
 *   - telnyx-sms-inbound: `replied` on any inbound lead SMS;
 *   - ai-flow-worker: `tag_added` (update_contact step), `claimed`
 *     (route_to_team claim finalization);
 *   - Next.js: `appointment_booked` (calendar tool bookings), `tag_added`
 *     (dashboard contact edits), imported the same Node<->Deno way as
 *     contact_ref.ts;
 *   - segment-action-sweep: `tag_added` (a Smart List's nightly action).
 *
 * That last one is the only caller that can RETRY a delivery: it announces
 * before it persists the tag, so a night that dies mid-write re-announces the
 * same milestone the next night. A delivery may therefore carry a
 * `dedupeKey` naming the milestone (not the attempt), and a keyed delivery is
 * at-most-once PER RUN: see `goalKeyConsumed`. Without a key, nothing about
 * this module changes, which is every other caller above.
 *
 * Runs parked on a HUMAN (`awaiting_approval` / `awaiting_agent`) are
 * deliberately left alone: an approval prompt or live teammate offer is
 * mid-conversation state a background jump must not yank away.
 */
import { RESUME_STEP_ID_VAR, flattenSteps } from "./branching.ts";
import type { FlowStep, GoalEvent, GoalEventKind } from "./types.ts";
import {
  contactKeyEmail,
  emailContactKey,
  emailIlikePattern
} from "../contact_key.ts";

/** Skip reason recorded on steps a goal jump short-circuited. */
export const GOAL_JUMP_SKIP = "goal_jump";

/**
 * Run statuses a goal jump may touch (never the human-parked ones).
 * awaiting_call is jumpable: the physical AI call proceeds unaffected (its
 * outcome resume is status-guarded and simply no-ops), while the run stops
 * nurturing a lead who just converted, e.g. an appointment booked DURING
 * the call window must not be lost to a one-shot event.
 */
export const JUMPABLE_STATUSES = ["queued", "awaiting_reply", "awaiting_call"] as const;

/** Most runs one event will jump per lead (same bound as the wait resumes). */
const MAX_RUNS_PER_EVENT = 25;

/**
 * Engine var stamped when an external event jumped the run to a goal step
 * (value = the event kind). Underscore-prefixed like the branch-choice /
 * sleep markers so the dashboard's var listing hides it.
 */
export function goalReachedVar(stepId: string): string {
  return `__goal_${stepId}`;
}

/**
 * Engine var stamped on a run a KEYED delivery fast-forwarded (value = the
 * event kind), so a retry of the same milestone can recognise its own work.
 * Underscore-prefixed like the goal-reached marker, so `presentableVars`
 * hides it from the dashboard's var listing.
 */
function goalEventKeyVar(dedupeKey: string): string {
  return `__goal_evt_${dedupeKey}`;
}

/** An observed external milestone. `tag` is set for tag_added only. */
export type ObservedGoalEvent = {
  kind: GoalEventKind;
  tag?: string;
  /**
   * Exactly-once name for the MILESTONE, not for the attempt, from a caller
   * whose delivery can be retried (today only the segment-action sweep, whose
   * `ce:segact:<segment>:<contact>:<tag>` key is also what the contact-event
   * enqueue dedupes on). Omitted everywhere else, and then this module
   * behaves exactly as it always has.
   */
  dedupeKey?: string;
};

type GoalStep = Extract<FlowStep, { type: "goal" }>;

/**
 * Pure: does this goal step watch for the observed event? tag_added matches
 * on the tag (case-insensitive); an authored tag_added without a tag never
 * matches (the schema requires one, this is runtime defense).
 */
export function goalStepMatches(step: GoalStep, event: ObservedGoalEvent): boolean {
  for (const g of Array.isArray(step.events) ? step.events : []) {
    if (!g || g.kind !== event.kind) continue;
    if (g.kind === "tag_added") {
      const want = (g.tag ?? "").trim().toLowerCase();
      const got = (event.tag ?? "").trim().toLowerCase();
      if (want && want === got) return true;
      continue;
    }
    return true;
  }
  return false;
}

// Minimal structural client (matches the _shared convention): only the query
// shapes this module uses, so both the edge runtime client and test fakes fit.
// deno-lint-ignore no-explicit-any
type AnyClient = any;

export type GoalJumpResult = {
  /** Runs whose current_step was fast-forwarded to a goal step. */
  jumpedRuns: number;
};

const NOOP: GoalJumpResult = { jumpedRuns: 0 };

type CandidateRun = {
  id: string;
  flow_id: string;
  business_id: string;
  status: string;
  current_step: number;
  context: Record<string, unknown> | null;
  revision: number;
  /** The key the run was ENQUEUED under, when it came from an event. */
  dedupe_key: string | null;
};

/**
 * Has this run already consumed this exact keyed delivery? Two marks, both
 * already durable on the run row, so the check costs no extra read:
 *
 *  - the run was ENQUEUED by this same milestone (`enqueueContactEventRuns`
 *    stores the key on the row it inserts). A flow started BY the event has
 *    to play its authored steps, not be jumped past them by the event that
 *    started it. That is the `excludeRunIds` rule, for the runs a caller
 *    cannot enumerate because a previous night created them.
 *  - a previous delivery of this key already fast-forwarded this run and
 *    stamped the marker var, in the same update as the jump. Without this, a
 *    retry could fast-forward the run AGAIN, on to a later goal watching the
 *    same tag, skipping everything in between.
 *
 * A run that was a candidate and did NOT jump needs no mark: nothing about it
 * changed, so a repeat delivery finds the same absence of a matching goal
 * ahead of it and is a no-op a second time.
 */
function goalKeyConsumed(run: CandidateRun, dedupeKey: string): boolean {
  if (run.dedupe_key === dedupeKey) return true;
  const vars = (run.context?.vars ?? {}) as Record<string, unknown>;
  return vars[goalEventKeyVar(dedupeKey)] !== undefined;
}

/**
 * Apply an observed milestone to every jumpable run for this lead. Never
 * throws; a failure on one run never blocks the others.
 *
 * `excludeRunIds`: runs the caller just resumed with THIS same event (a
 * wait_for_reply that consumed the reply), those must process the event
 * through their authored branch logic, not jump past it.
 */
/**
 * The filter that finds a lead's jumpable runs, by whichever identity they
 * were started with.
 *
 * A NUMBER matches the four places a phone can sit in a run's context: the
 * triggering sender, the extracted lead phone, the number a wait is parked on,
 * and the number a call is out to (the same identity keys the Customer Called
 * pause uses).
 *
 * An EMAIL-identified lead has none of those, which is why a booking by a
 * phoneless lead never reached their run and the `converted` jump never fired:
 * they kept getting follow-ups after they had already booked. Two more places
 * carry their identity instead. `trigger.from` holds the CONTACT KEY for a
 * contact-event run, which is how the follow-up cadence starts, and it is set
 * by the engine rather than by an authored var name, so it is the reliable
 * one. `vars.lead_email` holds the ADDRESS in a lead-source run. A flow using
 * a custom email var name matches only on the first, which is the same
 * degrade-to-previous-behavior the duplicate-lead guard documents for phones.
 *
 * Interpolation is safe for every branch: a number key is digits and `+`, and
 * an address that reached a contact key has already been refused if it carries
 * a PostgREST filter metacharacter (contact_key.ts).
 */
function runMatchFilter(leadKey: string): string {
  const key = emailContactKey(contactKeyEmail(leadKey) ?? leadKey);
  if (key) {
    const address = contactKeyEmail(key) as string;
    return [
      // The key is engine-set and always lowercased, so exact equality holds.
      `context->trigger->>from.eq.${key}`,
      // `lead_email` is whatever the flow's extraction produced, in whatever
      // casing it arrived in, so this half has to be case-insensitive. ilike
      // with the LIKE wildcards escaped is exact-modulo-case; an underscore is
      // common in a local part and unescaped would match a different person.
      `context->vars->>lead_email.ilike.${emailIlikePattern(address)}`
    ].join(",");
  }
  return [
    `context->trigger->>from.eq.${leadKey}`,
    `context->vars->>lead_phone.eq.${leadKey}`,
    `context->waiting_reply->>from.eq.${leadKey}`,
    `context->waiting_call->>to.eq.${leadKey}`
  ].join(",");
}

export async function applyGoalEvent(
  supabase: AnyClient,
  businessId: string,
  leadKey: string,
  event: ObservedGoalEvent,
  excludeRunIds: string[] = []
): Promise<GoalJumpResult> {
  if (!leadKey) return NOOP;
  try {
    const { data, error } = await supabase
      .from("ai_flow_runs")
      .select("id, flow_id, business_id, status, current_step, context, revision, dedupe_key")
      .eq("business_id", businessId)
      .in("status", [...JUMPABLE_STATUSES])
      .or(runMatchFilter(leadKey))
      .limit(MAX_RUNS_PER_EVENT);
    if (error) {
      console.error("goal_events: run lookup", error);
      return NOOP;
    }
    const runs = (data ?? []) as CandidateRun[];
    if (runs.length === 0) return NOOP;

    const definitions = await loadEnabledDefinitions(supabase, [
      ...new Set(runs.map((r) => r.flow_id))
    ]);

    let jumped = 0;
    for (const run of runs) {
      if (excludeRunIds.includes(run.id)) continue;
      if (event.dedupeKey && goalKeyConsumed(run, event.dedupeKey)) continue;
      const steps = definitions.get(run.flow_id);
      if (!steps) continue; // flow disabled / missing / malformed
      if (await jumpRunToGoal(supabase, run, steps, event)) jumped += 1;
    }
    return { jumpedRuns: jumped };
  } catch (e) {
    console.error("applyGoalEvent", e);
    return NOOP;
  }
}

/** Enabled flows' step lists, keyed by flow id (malformed rows dropped). */
async function loadEnabledDefinitions(
  supabase: AnyClient,
  flowIds: string[]
): Promise<Map<string, FlowStep[]>> {
  const out = new Map<string, FlowStep[]>();
  const { data, error } = await supabase
    .from("ai_flows")
    .select("id, definition")
    .in("id", flowIds)
    .eq("enabled", true)
    .is("deleted_at", null);
  if (error) {
    console.error("goal_events: flow lookup", error);
    return out;
  }
  for (const row of (data ?? []) as Array<{ id: string; definition?: unknown }>) {
    const def = row.definition as { steps?: unknown } | null;
    if (def && Array.isArray(def.steps)) out.set(row.id, def.steps as FlowStep[]);
  }
  return out;
}

/**
 * Fast-forward one run to its first matching goal step ahead of current_step.
 * Returns whether the jump landed (false = no matching goal, revision race
 * lost, or a write failure).
 */
async function jumpRunToGoal(
  supabase: AnyClient,
  run: CandidateRun,
  steps: FlowStep[],
  event: ObservedGoalEvent
): Promise<boolean> {
  const flat = flattenSteps(steps);
  let goalIndex = -1;
  for (let i = run.current_step + 1; i < flat.length; i += 1) {
    const entry = flat[i];
    // Trunk-only is enforced at author time; a nested goal in a stored row is
    // skipped here because a jump onto an unevaluated branch path is unsafe.
    if (entry.step.type !== "goal" || entry.branchPath.length > 0) continue;
    if (goalStepMatches(entry.step as GoalStep, event)) {
      goalIndex = i;
      break;
    }
  }
  if (goalIndex === -1) return false;
  const goalStep = flat[goalIndex].step as GoalStep;

  const prevVars =
    run.context?.vars && typeof run.context.vars === "object"
      ? (run.context.vars as Record<string, unknown>)
      : {};
  // A run parked on a wait_for_reply / place_ai_call carries the wait's
  // resolution marker; stamp it (like the reply/timeout/outcome resumes do)
  // so the parked step can never re-park, or re-DIAL, if anything ever
  // re-enters it.
  const waiting =
    (run.context?.waiting_reply as { marker?: unknown } | undefined) ?? {};
  const waitingCall =
    (run.context?.waiting_call as { marker?: unknown } | undefined) ?? {};
  const markerVars = {
    ...(typeof waiting.marker === "string" && waiting.marker.trim()
      ? { [waiting.marker]: "1" }
      : {}),
    ...(run.status === "awaiting_call" &&
    typeof waitingCall.marker === "string" &&
    waitingCall.marker.trim()
      ? { [waitingCall.marker]: "1" }
      : {})
  };
  // A keyed delivery records the key on the run in the SAME update as the
  // jump, so the mark and the jump share fate: either both landed and a retry
  // of this milestone leaves the run alone, or neither did and the retry is
  // the delivery. Only jumped runs are marked, which is also the only write
  // this module makes.
  const keyVars = event.dedupeKey ? { [goalEventKeyVar(event.dedupeKey)]: event.kind } : {};
  const nextContext = {
    ...(run.context ?? {}),
    vars: {
      ...prevVars,
      [goalReachedVar(goalStep.id)]: event.kind,
      ...markerVars,
      ...keyVars,
      // The jump moves current_step outside the worker's loop, so refresh the
      // resume marker to the goal step, a stale marker would relocate the
      // next claim back to wherever the run previously parked.
      [RESUME_STEP_ID_VAR]: goalStep.id
    },
    ...(run.status === "awaiting_reply"
      ? {
          waiting_reply: {
            ...(run.context?.waiting_reply as Record<string, unknown>),
            result: GOAL_JUMP_SKIP
          }
        }
      : {}),
    ...(run.status === "awaiting_call"
      ? {
          waiting_call: {
            ...(run.context?.waiting_call as Record<string, unknown>),
            result: GOAL_JUMP_SKIP
          }
        }
      : {})
  };
  // Optimistic concurrency: gate on the revision we read (trigger-bumped on
  // every update) so a concurrent claim/resume/timeout wins cleanly, losing
  // the race means the run moved on and this jump no longer applies.
  const { data: updated, error: updErr } = await supabase
    .from("ai_flow_runs")
    .update({
      status: "queued",
      current_step: goalIndex,
      context: nextContext,
      earliest_claim_at: null,
      respond_by_at: null,
      claimed_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .in("status", [...JUMPABLE_STATUSES])
    .select("id");
  if (updErr) {
    console.error("goal_events: run jump", updErr);
    return false;
  }
  if (((updated ?? []) as unknown[]).length === 0) return false;

  // Record the short-circuited steps as skipped (goal_jump) so run history
  // shows what the goal saved the lead from. Best-effort AFTER the jump won:
  // a step-row failure leaves history sparse, never the run state wrong.
  for (let i = run.current_step; i < goalIndex; i += 1) {
    const { error: stepErr } = await supabase.from("ai_flow_run_steps").upsert(
      {
        run_id: run.id,
        business_id: run.business_id,
        step_index: i,
        step_type: flat[i].step.type,
        status: "skipped",
        result: { skipped: GOAL_JUMP_SKIP, goal_step_id: goalStep.id, event: event.kind },
        error: null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "run_id,step_index" }
    );
    if (stepErr) console.error("goal_events: skip record", stepErr);
  }
  return true;
}
