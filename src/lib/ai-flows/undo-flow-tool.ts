/**
 * Shared core for the owner coworker's `undo_aiflow_edit` tool, the other
 * half of `edit_aiflow` (src/lib/ai-flows/edit-flow-tool.ts).
 *
 * `edit_aiflow` does not patch a definition, it regenerates the whole thing
 * through a model, so an edit the owner did not want cannot be reversed by
 * describing the inverse: a second generation is a second whole rewrite. The
 * only honest undo is putting the previous bytes back, which is what the
 * definition history (migration 20260822182135) exists for.
 *
 * Result objects go to the model verbatim, so wording here is model-facing
 * steering, not UI copy.
 */

import { z } from "zod";
import { listAiFlows } from "@/lib/ai-flows/db";
import { resolveAiFlowByRef } from "@/lib/ai-flows/manual-run-tool";
import { listFlowVersions, restoreFlowVersion } from "@/lib/ai-flows/versions";
import { announceFlowChange } from "@/lib/ai-flows/change-notice";

export const undoAiflowToolArgsSchema = z.object({
  flow: z.string().min(1).max(200)
});

export type UndoFlowToolDeps = {
  /** Injectable cores (tests). */
  listFlows?: typeof listAiFlows;
  fetchVersions?: typeof listFlowVersions;
  restoreVersion?: typeof restoreFlowVersion;
  announce?: typeof announceFlowChange;
  editSource?: string;
  editActor?: string | null;
};

export type UndoAiFlowToolResult =
  | {
      ok: true;
      flowId: string;
      flowName: string;
      restoredFrom: string;
      undoneSource: string | null;
      note: string;
    }
  | { ok: false; message: string };

/** Put back the version of one flow that the most recent edit replaced. */
export async function undoAiFlowEditTool(
  businessId: string,
  args: { flow: string },
  deps: UndoFlowToolDeps = {}
): Promise<UndoAiFlowToolResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const restoreVersion = deps.restoreVersion ?? restoreFlowVersion;
  const announce = deps.announce ?? announceFlowChange;
  /* c8 ignore stop */

  const flows = await listFlows(businessId);
  const resolved = resolveAiFlowByRef(flows, args.flow);
  if (!resolved.ok) return resolved;
  const flow = resolved.flow;

  const restored = await restoreVersion(businessId, flow.id, {
    ...(deps.fetchVersions ? { fetchVersions: deps.fetchVersions } : {}),
    ...(deps.editSource !== undefined ? { editSource: deps.editSource } : {}),
    ...(deps.editActor !== undefined ? { editActor: deps.editActor } : {})
  });
  if (!restored.ok) return { ok: false, message: restored.message };

  // Same out-of-band trace as an edit: an undo is a definition write too.
  await announce({
    businessId,
    flowId: restored.flowId,
    flowName: restored.flowName,
    action: "reverted",
    source: deps.editSource,
    actor: deps.editActor ?? null
  });

  return {
    ok: true,
    flowId: restored.flowId,
    flowName: restored.flowName,
    restoredFrom: restored.replacedAt,
    undoneSource: restored.undoneSource,
    // The undo is itself snapshotted, so "redo" is another undo. Say so:
    // an owner who reverses the wrong change should not think they are
    // now stuck with THAT.
    note: `Reverted "${restored.flowName}" to the version that was live before the last change, and the change you just undid is itself saved, so this is reversible too. Tell the owner what state the automation is back in, in plain words, and do NOT repeat the JSON definition.`
  };
}
