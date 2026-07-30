/**
 * Write-time validation for `browse_action` AiFlow steps (Standard+).
 */

import type { AiFlowDefinition, FlowStep } from "./schema";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

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
  /* c8 ignore next -- production default; tests inject */
  const allowed =
    deps.allowedForBusiness ?? browseActionAllowedForBusiness;
  if (await allowed(businessId)) return [];
  return [BROWSE_ACTION_UPGRADE_MESSAGE];
}
