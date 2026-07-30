/**
 * Write-time validation for `browse_action` AiFlow steps (Standard+).
 */

import type { AiFlowDefinition, FlowStep } from "./schema";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

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

export type ValidateBrowseActionDeps = {
  allowedForBusiness?: (businessId: string) => Promise<boolean>;
};

/**
 * Issues when the definition includes browse_action on a Starter (or
 * unknown) tier. Empty = ok.
 */
export async function validateBrowseActionSteps(
  businessId: string,
  def: AiFlowDefinition,
  deps: ValidateBrowseActionDeps = {}
): Promise<string[]> {
  const ids = collectBrowseActionSteps(def);
  if (ids.length === 0) return [];
  const check = deps.allowedForBusiness ?? browseActionAllowedForBusiness;
  if (!(await check(businessId))) return [BROWSE_ACTION_UPGRADE_MESSAGE];
  return [];
}
