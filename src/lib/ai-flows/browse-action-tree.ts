/**
 * Client-safe browse_action tree helpers (no server imports).
 *
 * Used by the AiFlowsManager banner. Write-time validation that needs the
 * tier lookup lives in browse-action-steps.ts (server-only).
 */

import type { AiFlowDefinition, FlowStep } from "./schema";

/** True when any step in the tree (including branch arms) is browse_action. */
export function flowStepsIncludeBrowseAction(steps: FlowStep[]): boolean {
  for (const step of steps) {
    if (step.type === "browse_action") return true;
    if (step.type === "branch") {
      for (const arm of step.branches) {
        if (flowStepsIncludeBrowseAction(arm.steps)) return true;
      }
      if (flowStepsIncludeBrowseAction(step.else)) return true;
    }
  }
  return false;
}

/** Every browse_action step id in the tree (trunk + branch arms + elses). */
export function collectBrowseActionSteps(def: AiFlowDefinition): string[] {
  const out: string[] = [];
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      if (step.type === "browse_action") {
        out.push(step.id);
      } else if (step.type === "branch") {
        for (const arm of step.branches) walk(arm.steps);
        walk(step.else);
      }
    }
  };
  walk(def.steps);
  return out;
}
