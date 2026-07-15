/**
 * AiFlow step-TREE helpers (pure, no IO) for the visual canvas builder.
 *
 * A definition's steps form a tree once `branch` steps exist (each arm and the
 * else path carry their own nested step list). The canvas editor addresses
 * nodes by STEP ID (unique across the whole tree — enforced at author time)
 * and edits immutably through these helpers; the classic form editor keeps
 * using flat-array indexing for trunk-only flows.
 *
 * `flattenForDisplay` mirrors the worker's execution flattening
 * (supabase/functions/_shared/ai_flows/branching.ts) so a recorded run step's
 * integer `step_index` can be mapped back to the tree node it executed — the
 * per-node stats overlay depends on the two orders staying identical:
 * branch step first, then every arm's steps in arm order, then the else steps.
 */
import type { BranchStep, FlowStep } from "@/lib/ai-flows/schema";

/** Where a step list lives: the trunk, one branch arm, or a branch's else. */
export type StepContainerRef =
  | { kind: "trunk" }
  | { kind: "arm"; branchId: string; armId: string }
  | { kind: "else"; branchId: string };

export type FlatDisplayEntry = {
  step: FlowStep;
  /** The container the step sits in (for insert-after operations). */
  container: StepContainerRef;
  /** Position within its container. */
  indexInContainer: number;
  /** Nesting depth (0 = trunk). */
  depth: number;
};

/**
 * Depth-first flatten in the worker's execution order. The returned array's
 * positions are the run `step_index` values the worker records.
 */
export function flattenForDisplay(
  steps: FlowStep[],
  container: StepContainerRef = { kind: "trunk" },
  depth = 0
): FlatDisplayEntry[] {
  const out: FlatDisplayEntry[] = [];
  steps.forEach((step, indexInContainer) => {
    out.push({ step, container, indexInContainer, depth });
    if (step.type !== "branch") return;
    for (const arm of step.branches) {
      out.push(
        ...flattenForDisplay(arm.steps, { kind: "arm", branchId: step.id, armId: arm.id }, depth + 1)
      );
    }
    out.push(...flattenForDisplay(step.else, { kind: "else", branchId: step.id }, depth + 1));
  });
  return out;
}

/** Find a step anywhere in the tree by id. */
export function findStepById(steps: FlowStep[], id: string): FlowStep | null {
  for (const step of steps) {
    if (step.id === id) return step;
    if (step.type !== "branch") continue;
    for (const arm of step.branches) {
      const hit = findStepById(arm.steps, id);
      if (hit) return hit;
    }
    const hit = findStepById(step.else, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Immutably replace the step with `id` using `update` (returning null deletes
 * it). Containers along the path are copied; untouched subtrees are shared.
 */
function mapStepById(
  steps: FlowStep[],
  id: string,
  update: (step: FlowStep) => FlowStep | null
): FlowStep[] {
  let changed = false;
  const next: FlowStep[] = [];
  for (const step of steps) {
    if (step.id === id) {
      changed = true;
      const updated = update(step);
      if (updated) next.push(updated);
      continue;
    }
    if (step.type === "branch") {
      const branches = step.branches.map((arm) => {
        const armSteps = mapStepById(arm.steps, id, update);
        return armSteps === arm.steps ? arm : { ...arm, steps: armSteps };
      });
      const elseSteps = mapStepById(step.else, id, update);
      if (branches.some((arm, i) => arm !== step.branches[i]) || elseSteps !== step.else) {
        changed = true;
        next.push({ ...step, branches, else: elseSteps });
        continue;
      }
    }
    next.push(step);
  }
  return changed ? next : steps;
}

/** Immutably merge a partial patch into the step with `id`. */
export function patchStepById(
  steps: FlowStep[],
  id: string,
  patch: Record<string, unknown>
): FlowStep[] {
  return mapStepById(steps, id, (step) => ({ ...step, ...patch }) as FlowStep);
}

/** Immutably remove the step with `id` (and, for a branch, its whole subtree). */
export function removeStepById(steps: FlowStep[], id: string): FlowStep[] {
  return mapStepById(steps, id, () => null);
}

/** The (live) step list a container ref points at, or null when it's gone. */
function resolveContainer(steps: FlowStep[], container: StepContainerRef): FlowStep[] | null {
  if (container.kind === "trunk") return steps;
  const branch = findStepById(steps, container.branchId);
  if (!branch || branch.type !== "branch") return null;
  if (container.kind === "else") return branch.else;
  const arm = branch.branches.find((a) => a.id === container.armId);
  return arm ? arm.steps : null;
}

/** Immutably write a container's step list back into the tree. */
function replaceContainer(
  steps: FlowStep[],
  container: StepContainerRef,
  nextList: FlowStep[]
): FlowStep[] {
  if (container.kind === "trunk") return nextList;
  return mapStepById(steps, container.branchId, (step) => {
    /* c8 ignore next 2 -- callers resolveContainer() first, so the id is always a branch */
    if (step.type !== "branch") return step;
    if (container.kind === "else") return { ...step, else: nextList };
    return {
      ...step,
      branches: step.branches.map((arm) =>
        arm.id === container.armId ? { ...arm, steps: nextList } : arm
      )
    };
  });
}

/**
 * Immutably insert `step` into `container` at `index` (clamped). Returns the
 * original array when the container no longer exists.
 */
export function insertStepAt(
  steps: FlowStep[],
  container: StepContainerRef,
  index: number,
  step: FlowStep
): FlowStep[] {
  const list = resolveContainer(steps, container);
  if (!list) return steps;
  const at = Math.max(0, Math.min(index, list.length));
  return replaceContainer(steps, container, [...list.slice(0, at), step, ...list.slice(at)]);
}

/** Immutably move the step with `id` up/down WITHIN its own container. */
export function moveStepById(steps: FlowStep[], id: string, dir: -1 | 1): FlowStep[] {
  const entry = flattenForDisplay(steps).find((e) => e.step.id === id);
  if (!entry) return steps;
  const list = resolveContainer(steps, entry.container);
  /* c8 ignore next -- the entry came from this same tree, so its container always resolves */
  if (!list) return steps;
  const i = entry.indexInContainer;
  const j = i + dir;
  if (j < 0 || j >= list.length) return steps;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return replaceContainer(steps, entry.container, next);
}

/** Vars a single step produces (visible to LATER steps in flat order). */
export function varsProducedByStep(step: FlowStep): string[] {
  if (step.type === "extract_url") return [step.saveAs];
  if (step.type === "browse_extract")
    return [
      ...(step.fields ?? []).map((f) => f.name),
      ...(step.extractLinks ?? []).map((l) => l.name)
    ].filter(Boolean);
  if (step.type === "extract_text") return step.fields.map((f) => f.name).filter(Boolean);
  if (step.type === "email_extract") return step.fields.map((f) => f.name).filter(Boolean);
  if (step.type === "browse_action") return (step.fields ?? []).map((f) => f.name).filter(Boolean);
  if (step.type === "http_call" && step.saveAs) return [step.saveAs];
  if (step.type === "recall_url") return [step.saveAs];
  if (step.type === "wait_for_reply") return [step.saveAs ?? "reply_text"];
  if (step.type === "classify") return [step.saveAs];
  if (step.type === "generate_image") return [step.saveAs];
  if (step.type === "share_document" && step.saveAs) return [step.saveAs];
  if (step.type === "run_agent") return [step.saveAs];
  return [];
}

/**
 * All vars produced by steps BEFORE the step with `id` in the worker's flat
 * execution order — the legal targets for its `when` guard / arm conditions
 * (matching validateDefinitionSemantics' permissive cross-arm scope).
 */
export function varsInScopeBefore(steps: FlowStep[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of flattenForDisplay(steps)) {
    if (entry.step.id === id) break;
    for (const v of varsProducedByStep(entry.step)) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/** True when any step in the tree is a branch (classic form can't author it). */
export function hasBranchStep(steps: FlowStep[]): boolean {
  return flattenForDisplay(steps).some((e) => e.step.type === "branch");
}

/** Per-node run-history counts for the canvas stats overlay. */
export type StepStats = { done: number; skipped: number; failed: number };

/**
 * Aggregate recorded run steps into per-node stats keyed by STEP ID. Rows are
 * `ai_flow_run_steps` projections; `step_index` is the worker's flat execution
 * index, which maps onto `flattenForDisplay`'s order (kept identical by
 * design).
 *
 * Historical rows can be STALE relative to the current definition (runs don't
 * snapshot the definition, and editing the flow shifts flat indices), so rows
 * are dropped when they can't belong to today's tree: past the flattened
 * length, or recorded with a different `step_type` than the step now at that
 * index. Callers should additionally scope the run set to runs started after
 * the flow's last edit (see the flow detail page). Non-terminal statuses
 * (running/pending) are ignored.
 */
export function statsByStepIdFromRunSteps(
  steps: FlowStep[],
  rows: Array<{ step_index: number; step_type: string; status: string }>
): Record<string, StepStats> {
  const flat = flattenForDisplay(steps);
  const out: Record<string, StepStats> = {};
  for (const row of rows) {
    const entry = flat[row.step_index];
    if (!entry || entry.step.type !== row.step_type) continue;
    if (row.status !== "done" && row.status !== "skipped" && row.status !== "failed") continue;
    const id = entry.step.id;
    const stats = (out[id] ??= { done: 0, skipped: 0, failed: 0 });
    stats[row.status as keyof StepStats] += 1;
  }
  return out;
}

/** Type guard used by the canvas when narrowing a selected node. */
export function isBranchStep(step: FlowStep): step is BranchStep {
  return step.type === "branch";
}
