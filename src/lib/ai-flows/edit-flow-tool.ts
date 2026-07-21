/**
 * Shared core for the owner coworker's `edit_aiflow` tool — used by the
 * dashboard-chat INLINE path (src/lib/dashboard-chat/action-tools.ts) and
 * the owner-over-SMS surface (both run the same inline engine).
 *
 * Applies a validated, in-place edit to an EXISTING flow: resolve the flow
 * (same reference matching as run_aiflow), run the edit compile pipeline
 * (src/lib/ai-flows/compile-service.ts — full validation, one-shot
 * self-repair, NO salvage), then persist through `updateAiFlow`. The flow
 * keeps its id, run history, and enabled state; anything short of a cleanly
 * validated definition refuses and leaves the flow byte-identical. Result
 * objects go to the model verbatim, so wording here is model-facing
 * steering, not UI copy.
 */

import { z } from "zod";
import { listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { editAiFlowDefinition } from "@/lib/ai-flows/compile-service";
import { resolveAiFlowByRef } from "@/lib/ai-flows/manual-run-tool";
import { logger } from "@/lib/logger";

export const editAiflowToolArgsSchema = z.object({
  flow: z.string().min(1).max(200),
  // Same bound as the compile description the create tool accepts.
  instructions: z.string().min(1).max(4000),
  newName: z.string().min(1).max(120).optional()
});

export type EditFlowToolDeps = {
  /** Injectable cores (tests). */
  listFlows?: typeof listAiFlows;
  compileEdit?: typeof editAiFlowDefinition;
  persistUpdate?: typeof updateAiFlow;
};

export type EditAiFlowToolResult =
  | {
      ok: true;
      flowId: string;
      flowName: string;
      enabled: boolean;
      stepCount: number;
      triggerChannel: string;
      note: string;
    }
  | { ok: false; message: string };

/** Edit one existing flow in place per the owner's confirmed instruction. */
export async function editAiFlowTool(
  businessId: string,
  args: { flow: string; instructions: string; newName?: string },
  deps: EditFlowToolDeps = {}
): Promise<EditAiFlowToolResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const compileEdit = deps.compileEdit ?? editAiFlowDefinition;
  const persistUpdate = deps.persistUpdate ?? updateAiFlow;
  /* c8 ignore stop */

  const flows = await listFlows(businessId);
  const resolved = resolveAiFlowByRef(flows, args.flow);
  if (!resolved.ok) return resolved;
  const flow = resolved.flow;

  const compiled = await compileEdit({
    businessId,
    flowName: flow.name,
    currentDefinition: flow.definition,
    instructions: args.instructions
  });
  if (!compiled.ok) {
    // The pipeline's message already says the flow was NOT changed.
    return { ok: false, message: compiled.message };
  }

  let updated;
  try {
    updated = await persistUpdate({
      businessId,
      id: flow.id,
      definition: compiled.definition,
      ...(args.newName ? { name: args.newName } : {})
    });
  } catch (err) {
    logger.warn("edit_aiflow: persist failed", {
      businessId,
      flowId: flow.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "The edited automation validated but could not be saved — the flow was NOT changed. Tell the owner to try again."
    };
  }

  return {
    ok: true,
    flowId: updated.id,
    flowName: updated.name,
    enabled: updated.enabled,
    stepCount: compiled.definition.steps.length,
    triggerChannel: compiled.definition.trigger.channel,
    note: `The automation was updated and the change is live${
      updated.enabled ? "" : " (the flow itself is still disabled)"
    }. Summarize exactly what changed and mention the owner can review it at /dashboard/aiflows?edit=${updated.id}. Do NOT repeat the JSON definition.`
  };
}
