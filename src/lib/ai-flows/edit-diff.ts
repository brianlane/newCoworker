/**
 * What an AiFlow edit would actually do, in plain English, plus how far its
 * blast radius reaches. Pure: no IO, no model call.
 *
 * The confirmation step exists because `edit_aiflow` REGENERATES a whole
 * definition rather than patching one, so "the model said it would reword a
 * message" and "the model rewrote the automation" are not distinguishable
 * from the instruction alone. The owner has to be told what actually came
 * back, which means diffing the compiled definition against the live one.
 *
 * The risk classification exists because `ai_flow_runs.current_step` is a
 * flat index over the FLATTENED definition (see branching.ts). Adding a step
 * near the top renumbers everything after it and walks every parked run onto
 * the wrong instruction. That is not a thing to confirm over SMS in one line;
 * it is a thing to refuse and hand to the dashboard.
 */
import { flattenSteps } from "../../../supabase/functions/_shared/ai_flows/branching";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

/** How much of the automation an edit disturbs. Ordered least to most. */
export type EditRisk = "none" | "wording" | "behavioral" | "structural" | "in_flight";

/**
 * Step types whose fields aim at a page we do not control. A changed selector
 * or marker here is not wording: it changes what the automation DOES on
 * someone else's website, it cannot be judged from the sentence describing
 * it, and when it is wrong the step fails silently on a live lead days later.
 */
const THIRD_PARTY_PAGE_STEPS = new Set(["browse_action", "browse_extract"]);

/**
 * Fields that decide whether a step runs at all, on any step type. Changing
 * one is a change to the automation's behavior even when every message in it
 * is untouched.
 */
const GATING_FIELDS = new Set(["when"]);

export type FlowEditDiff = {
  renamedTo: string | null;
  triggerChanged: boolean;
  stepsAdded: string[];
  stepsRemoved: string[];
  /** Step ids present in both, with at least one field different. */
  stepsChanged: string[];
  /**
   * The subset of `stepsChanged` whose change is not merely wording: a step
   * that acts on a third-party page, or a change to whether a step runs. The
   * text surfaces refuse these, so they reach the dashboard where the owner
   * can see the page and the whole automation.
   */
  stepsChangedBeyondWording: string[];
  /**
   * First flat execution index where the two definitions stop agreeing on
   * which step runs, or null when the flattened id lists are identical.
   * This, not the step count, is what decides whether a parked run moves.
   */
  firstDivergenceIndex: number | null;
  /** Plain-English lines, in the order they should be read out. */
  summary: string[];
};

/** Longest before/after wording pair we inline; longer values are described. */
const INLINE_VALUE_MAX = 120;

function flatIds(def: AiFlowDefinition): string[] {
  return flattenSteps(def.steps as never).map((entry) => {
    const step = entry.step as unknown as { id: string };
    return step.id;
  });
}

/** Every step in a (possibly nested) definition, keyed by id. */
function stepsById(def: AiFlowDefinition): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const entry of flattenSteps(def.steps as never)) {
    const step = entry.step as unknown as Record<string, unknown>;
    // flattenSteps already drops anything without a string id, so the only
    // case left is a duplicate: first occurrence wins, matching the engine,
    // which executes the first entry it reaches.
    if (!out.has(step.id as string)) out.set(step.id as string, step);
  }
  return out;
}

/**
 * Field names that differ between two versions of the same step. `steps` and
 * `branches` are skipped: nested children are their own entries in the
 * flattened list, so comparing them here would report a parent branch as
 * "changed" for every edit anywhere beneath it.
 */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const skip = new Set(["steps", "branches", "else"]);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const name of names) {
    if (skip.has(name)) continue;
    if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) out.push(name);
  }
  return out.sort();
}

function describeValue(value: unknown): string {
  if (value === undefined) return "(nothing)";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "(empty)";
    return trimmed.length <= INLINE_VALUE_MAX
      ? `"${trimmed}"`
      : `"${trimmed.slice(0, INLINE_VALUE_MAX)}..."`;
  }
  // Definitions come from parsed JSON, and `undefined` is handled above, so
  // stringify always returns a string here.
  const json = JSON.stringify(value);
  return json.length <= INLINE_VALUE_MAX ? json : `${json.slice(0, INLINE_VALUE_MAX)}...`;
}

/** Diff a compiled edit against the definition it would replace. */
export function diffFlowDefinitions(
  before: AiFlowDefinition,
  after: AiFlowDefinition,
  opts: { currentName?: string; newName?: string } = {}
): FlowEditDiff {
  const beforeIds = flatIds(before);
  const afterIds = flatIds(after);
  const beforeSteps = stepsById(before);
  const afterSteps = stepsById(after);

  const stepsAdded = afterIds.filter((id) => !beforeSteps.has(id));
  const stepsRemoved = beforeIds.filter((id) => !afterSteps.has(id));
  const stepsChanged: string[] = [];
  const stepsChangedBeyondWording: string[] = [];
  const fieldLines: string[] = [];
  // Iterate the MAP, not the flat id list: a duplicate id appears twice in
  // the flat list and would otherwise be reported as changed twice.
  for (const id of beforeSteps.keys()) {
    const b = beforeSteps.get(id);
    const a = afterSteps.get(id);
    if (!b || !a) continue;
    const fields = changedFields(b, a);
    if (fields.length === 0) continue;
    stepsChanged.push(id);
    // Read the type off BOTH sides: a step whose type itself changed is a
    // different instruction under the same id, and if either side touches a
    // third-party page the owner needs to see it.
    const touchesThirdPartyPage =
      THIRD_PARTY_PAGE_STEPS.has(String(b.type)) || THIRD_PARTY_PAGE_STEPS.has(String(a.type));
    if (touchesThirdPartyPage || fields.some((f) => GATING_FIELDS.has(f))) {
      stepsChangedBeyondWording.push(id);
    }
    for (const field of fields) {
      fieldLines.push(
        `Step "${id}": ${field} changes from ${describeValue(b[field])} to ${describeValue(a[field])}.`
      );
    }
  }

  let firstDivergenceIndex: number | null = null;
  const longest = Math.max(beforeIds.length, afterIds.length);
  for (let i = 0; i < longest; i += 1) {
    if (beforeIds[i] !== afterIds[i]) {
      firstDivergenceIndex = i;
      break;
    }
  }

  const triggerChanged =
    JSON.stringify(before.trigger) !== JSON.stringify(after.trigger);
  const renamedTo =
    opts.newName !== undefined && opts.newName !== opts.currentName ? opts.newName : null;

  const summary: string[] = [];
  if (renamedTo) summary.push(`Renames the automation to "${renamedTo}".`);
  if (triggerChanged) summary.push("Changes what STARTS the automation (its trigger).");
  if (stepsRemoved.length > 0) {
    summary.push(
      `Removes ${stepsRemoved.length} step${stepsRemoved.length === 1 ? "" : "s"}: ${stepsRemoved.join(", ")}.`
    );
  }
  if (stepsAdded.length > 0) {
    summary.push(
      `Adds ${stepsAdded.length} step${stepsAdded.length === 1 ? "" : "s"}: ${stepsAdded.join(", ")}.`
    );
  }
  summary.push(...fieldLines);
  if (summary.length === 0) summary.push("Nothing would change.");

  return {
    renamedTo,
    triggerChanged,
    stepsAdded,
    stepsRemoved,
    stepsChanged,
    stepsChangedBeyondWording,
    firstDivergenceIndex,
    summary
  };
}

/**
 * How dangerous the edit is, given how far the flow's live runs have already
 * progressed.
 *
 * `highestLiveStep` is the largest `current_step` among this flow's runs in a
 * non-terminal state, or null when nothing is in flight. A divergence at or
 * before that index means at least one parked run would resume on a
 * different instruction than the one it parked on.
 */
export function classifyEditRisk(
  diff: FlowEditDiff,
  highestLiveStep: number | null
): EditRisk {
  const structural =
    diff.firstDivergenceIndex !== null ||
    diff.triggerChanged ||
    diff.stepsAdded.length > 0 ||
    diff.stepsRemoved.length > 0;
  if (
    diff.firstDivergenceIndex !== null &&
    highestLiveStep !== null &&
    diff.firstDivergenceIndex <= highestLiveStep
  ) {
    return "in_flight";
  }
  if (structural) return "structural";
  // Between wording and structural: the step list is untouched (so no parked
  // run moves) but what a step DOES changed. Ranked above wording because the
  // text surfaces judge on the sentence describing the edit, and "point the
  // claim button at the new label" reads like a trivial fix right up until it
  // silently stops claiming leads.
  if (diff.stepsChangedBeyondWording.length > 0) return "behavioral";
  if (diff.stepsChanged.length > 0 || diff.renamedTo !== null) return "wording";
  return "none";
}
