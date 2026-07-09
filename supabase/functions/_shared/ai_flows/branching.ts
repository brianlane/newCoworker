/**
 * AiFlows branch execution helpers (pure, no IO).
 *
 * A `branch` step gives a flow real multi-way control flow (GHL-style
 * If/Else). The definition stores the arms NESTED (each arm carries its own
 * step list), but the worker's run state machine is built around a FLAT
 * integer `current_step` (every park/resume path — approval gates, agent
 * offers, reply waits, quiet-hour deferrals — stores and rewinds that index).
 * Rather than rework all of that, the worker flattens the nested definition
 * into a deterministic execution list at claim time:
 *
 *   - `flattenSteps` walks the tree depth-first: a branch step is emitted
 *     first, then every arm's steps in order, then the else steps. Each entry
 *     carries its `branchPath` — the chain of (branch step id, arm id) pairs
 *     it lives under.
 *   - Executing a branch step evaluates its arms top to bottom (first match
 *     wins, falling through to "else") and records the choice in the engine
 *     var `__branch_<stepId>` (persisted with the run vars, so it survives
 *     parks and resumes).
 *   - Before running any step, the worker checks `isOnActivePath`: an entry
 *     whose branchPath disagrees with a recorded choice is SKIPPED (recorded
 *     "skipped" with reason branch_not_taken), exactly like a when_unmet skip.
 *
 * Flattening is a pure function of the definition, so the same definition
 * always yields the same indices — a parked run resumes at the same flat
 * index it parked on.
 */
import { evaluateStepCondition } from "./engine.ts";
import type { FlowStep } from "./types.ts";

/** The arm id recorded when no arm's condition matched. */
export const BRANCH_ELSE_ARM = "else";

/** Engine var a branch step records its chosen arm id into. */
export function branchChoiceVar(branchStepId: string): string {
  return `__branch_${branchStepId}`;
}

/** One (branch step, chosen arm) hop in the path from the trunk to a step. */
export type BranchPathHop = {
  branchStepId: string;
  armId: string;
};

/** A flattened execution entry: the step plus the branch arms it lives under. */
export type FlatStepEntry = {
  step: FlowStep;
  branchPath: BranchPathHop[];
};

/**
 * Flatten a (possibly nested) step list into the deterministic execution
 * order: each branch step first, then its arms' steps in arm order, then its
 * else steps. Defensive against malformed stored rows: a non-object step or
 * one without string id/type is dropped, and a branch with malformed
 * arms/else treats them as empty (the run degrades instead of throwing deep
 * in the loop).
 */
export function flattenSteps(
  steps: FlowStep[],
  path: BranchPathHop[] = []
): FlatStepEntry[] {
  const out: FlatStepEntry[] = [];
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as unknown as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.type !== "string") continue;
    out.push({ step, branchPath: path });
    if (step.type !== "branch") continue;
    const arms = Array.isArray(step.branches) ? step.branches : [];
    for (const arm of arms) {
      if (!arm || typeof arm !== "object" || typeof arm.id !== "string") continue;
      out.push(
        ...flattenSteps(Array.isArray(arm.steps) ? arm.steps : [], [
          ...path,
          { branchStepId: step.id, armId: arm.id }
        ])
      );
    }
    out.push(
      ...flattenSteps(Array.isArray(step.else) ? step.else : [], [
        ...path,
        { branchStepId: step.id, armId: BRANCH_ELSE_ARM }
      ])
    );
  }
  return out;
}

/**
 * Evaluate a branch step's arms top to bottom against the run vars; the first
 * arm whose condition holds wins. Returns its arm id, or BRANCH_ELSE_ARM when
 * none match.
 */
export function chooseBranchArm(
  step: Extract<FlowStep, { type: "branch" }>,
  scope: { vars?: Record<string, unknown> }
): string {
  for (const arm of Array.isArray(step.branches) ? step.branches : []) {
    if (!arm || typeof arm !== "object" || !arm.condition) continue;
    if (evaluateStepCondition(arm.condition, scope)) return arm.id;
  }
  return BRANCH_ELSE_ARM;
}

/**
 * Is this flattened entry on the taken path? Every hop's recorded choice
 * (`__branch_<id>` in the run vars) must equal the entry's arm id. A hop
 * whose choice is missing (its branch step was itself skipped, or hasn't run
 * yet) is NOT on the active path — an unevaluated branch must never execute
 * its children.
 */
export function isOnActivePath(
  branchPath: BranchPathHop[],
  vars: Record<string, unknown>
): boolean {
  for (const hop of branchPath) {
    if (vars[branchChoiceVar(hop.branchStepId)] !== hop.armId) return false;
  }
  return true;
}
