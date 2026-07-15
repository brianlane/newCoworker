/**
 * Staff Task Center — pure helpers.
 *
 * A "task" is a lead in motion: a contact with non-terminal AiFlow runs
 * and/or lead-state tags. The Task Center card combines five facets — the
 * active workflow position, the lead state (tags + owner), the goal-event
 * timeline, the collected info (run vars), and the AI's response reasoning.
 *
 * This module holds the PURE shaping logic (unit-tested under the lib
 * coverage gate); the IO aggregation lives in /api/dashboard/tasks, which
 * feeds these helpers rows it fetched.
 */
import type { FlowStep } from "@/lib/ai-flows/schema";
import { flattenForDisplay } from "@/lib/ai-flows/tree";
import { STEP_TYPE_LABELS } from "@/components/dashboard/aiflow-labels";

/** Run statuses that make a lead "in motion" (everything non-terminal). */
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_agent",
  "awaiting_reply",
  "awaiting_call"
] as const;

const E164_RE = /^\+[1-9]\d{6,15}$/;

/**
 * The phone identifying a run's LEAD: the extracted `lead_phone` var when an
 * extraction produced one, else the triggering sender. Mirrors the worker's
 * leadContactPhone. Null when neither looks like a phone (schedule/webhook
 * runs with no extracted lead yet).
 */
export function taskLeadPhone(context: Record<string, unknown>): string | null {
  const vars = context.vars;
  const fromVars =
    vars && typeof vars === "object" && !Array.isArray(vars)
      ? (vars as Record<string, unknown>).lead_phone
      : undefined;
  if (typeof fromVars === "string" && E164_RE.test(fromVars.trim())) return fromVars.trim();
  const trigger = context.trigger;
  const from =
    trigger && typeof trigger === "object" && !Array.isArray(trigger)
      ? (trigger as Record<string, unknown>).from
      : undefined;
  if (typeof from === "string" && E164_RE.test(from.trim())) return from.trim();
  return null;
}

export type RunPosition = {
  /** 1-based position in the flattened execution order (0 = finished). */
  stepNumber: number;
  /** Flattened step count. */
  totalSteps: number;
  /** Friendly label of the current node ("Finished" past the end). */
  nodeLabel: string;
  /** Raw step type of the current node ("" past the end). */
  stepType: string;
};

/**
 * Where a run currently sits: map its integer cursor back through the same
 * flattened order the worker executes (branch step, then arms, then else).
 */
export function runPosition(steps: FlowStep[], currentStep: number): RunPosition {
  const flat = flattenForDisplay(Array.isArray(steps) ? steps : []);
  const total = flat.length;
  if (currentStep >= total || currentStep < 0 || total === 0) {
    return { stepNumber: 0, totalSteps: total, nodeLabel: "Finished", stepType: "" };
  }
  const step = flat[currentStep].step;
  const label =
    step.type === "goal"
      ? `Goal: ${step.label}`
      : (STEP_TYPE_LABELS as Record<string, string>)[step.type] ?? step.type;
  return {
    stepNumber: currentStep + 1,
    totalSteps: total,
    nodeLabel: label,
    stepType: step.type
  };
}

export type GoalTimelineEntry = {
  runId: string;
  /** The goal step's display label (from the recorded result). */
  label: string;
  /** How the run arrived: "passed_inline" or the jump's event kind. */
  via: string;
  /** ISO timestamp of the step record. */
  at: string;
};

type GoalStepRow = {
  run_id: string;
  step_type: string;
  status: string;
  result: Record<string, unknown> | null;
  updated_at: string;
};

/**
 * The goal-event timeline from recorded run steps: every goal checkpoint a
 * run has completed (inline or via a jump), newest first. Skipped goal rows
 * (a jump PAST a non-matching goal) are not milestones and are dropped.
 */
export function goalTimeline(rows: GoalStepRow[]): GoalTimelineEntry[] {
  const out: GoalTimelineEntry[] = [];
  for (const row of rows) {
    if (row.step_type !== "goal" || row.status !== "done") continue;
    const result = row.result ?? {};
    const label = typeof result.goal === "string" && result.goal ? result.goal : "Goal";
    const via = typeof result.reached_via === "string" && result.reached_via
      ? result.reached_via
      : "passed_inline";
    out.push({ runId: row.run_id, label, via, at: row.updated_at });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Human wording for how a goal was reached (Task Center + run history). */
export function goalViaText(via: string): string {
  switch (via) {
    case "replied":
      return "they texted back";
    case "appointment_booked":
      return "an appointment was booked";
    case "claimed":
      return "a teammate claimed the lead";
    case "tag_added":
      return "a tag was added";
    case "passed_inline":
      return "reached in sequence";
    default:
      return via;
  }
}
