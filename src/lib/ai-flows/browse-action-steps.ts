/**
 * Write-time validation for `browse_action` AiFlow steps (Standard+).
 */

import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";
import {
  collectBrowseActionSteps,
  flowStepsIncludeBrowseAction
} from "./browse-action-tree";
import type { AiFlowDefinition } from "./schema";

export { collectBrowseActionSteps, flowStepsIncludeBrowseAction };

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
