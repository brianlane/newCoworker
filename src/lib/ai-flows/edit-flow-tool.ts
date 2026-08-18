/**
 * Shared core for the owner coworker's `edit_aiflow` tool, used by the
 * dashboard-chat INLINE path (src/lib/dashboard-chat/action-tools.ts) and the
 * owner-over-SMS surface (both run the same inline engine).
 *
 * TWO CALLS, not one. The first call compiles the edit, diffs it against the
 * live definition and STAGES it; it writes nothing to ai_flows. The second
 * call, carrying the token the first returned, applies the staged bytes.
 *
 * Why the gate is mechanical rather than a sentence in the tool description:
 * the description used to say "use ONLY after the owner explicitly
 * confirmed", and nothing enforced it. A model handed a written-out
 * multi-part spec reasonably reads it as already confirmed, because the owner
 * did write it all out. On SMS that means one text message rewriting live
 * automations in a single turn.
 *
 * Why the compiled definition is stored rather than recompiled on confirm:
 * this tool does not patch a definition, it REGENERATES the whole thing
 * through a model, so the same instruction run twice can produce two
 * different results. Confirming a described change and then applying a
 * freshly generated one would make the confirmation meaningless.
 *
 * Result objects go to the model verbatim, so wording here is model-facing
 * steering, not UI copy.
 */

import { z } from "zod";
import { highestActiveRunStep, listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { editAiFlowDefinition } from "@/lib/ai-flows/compile-service";
import { resolveAiFlowByRef } from "@/lib/ai-flows/manual-run-tool";
import { classifyEditRisk, diffFlowDefinitions } from "@/lib/ai-flows/edit-diff";
import { consumePendingEdit, stagePendingEdit } from "@/lib/ai-flows/pending-edits";
import { logger } from "@/lib/logger";

export const editAiflowToolArgsSchema = z.object({
  flow: z.string().min(1).max(200),
  // Same bound as the compile description the create tool accepts.
  instructions: z.string().min(1).max(4000),
  newName: z.string().min(1).max(120).optional(),
  /** Present only on the SECOND call: the token the staging call returned. */
  confirmationToken: z.string().min(1).max(80).optional()
});

/**
 * Surfaces where the owner cannot see the automation while deciding, and a
 * reply is a line of text. A wording change is a reasonable thing to approve
 * by text; a change to what the automation DOES is not.
 */
export type EditSurfaceKind = "rich" | "text";

export type EditFlowToolDeps = {
  /** Injectable cores (tests). */
  listFlows?: typeof listAiFlows;
  compileEdit?: typeof editAiFlowDefinition;
  persistUpdate?: typeof updateAiFlow;
  highestLiveStep?: typeof highestActiveRunStep;
  stageEdit?: typeof stagePendingEdit;
  consumeEdit?: typeof consumePendingEdit;
  /** Defaults to "rich"; the SMS and email surfaces pass "text". */
  surfaceKind?: EditSurfaceKind;
  editSource?: string;
  editActor?: string | null;
};

export type EditAiFlowToolResult =
  | {
      ok: true;
      staged: true;
      confirmationToken: string;
      flowId: string;
      flowName: string;
      risk: string;
      summary: string[];
      note: string;
    }
  | {
      ok: true;
      staged?: false;
      flowId: string;
      flowName: string;
      enabled: boolean;
      stepCount: number;
      triggerChannel: string;
      note: string;
    }
  | { ok: false; message: string };

/** Where an owner is sent when an edit is too structural to approve by text. */
function dashboardPointer(flowId: string): string {
  return `/dashboard/aiflows?edit=${flowId}`;
}

/** Edit one existing flow: stage on the first call, apply on the second. */
export async function editAiFlowTool(
  businessId: string,
  args: { flow: string; instructions: string; newName?: string; confirmationToken?: string },
  deps: EditFlowToolDeps = {}
): Promise<EditAiFlowToolResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listFlows = deps.listFlows ?? listAiFlows;
  const compileEdit = deps.compileEdit ?? editAiFlowDefinition;
  const persistUpdate = deps.persistUpdate ?? updateAiFlow;
  const highestLiveStep = deps.highestLiveStep ?? highestActiveRunStep;
  const stageEdit = deps.stageEdit ?? stagePendingEdit;
  const consumeEdit = deps.consumeEdit ?? consumePendingEdit;
  const surfaceKind = deps.surfaceKind ?? "rich";
  /* c8 ignore stop */

  const flows = await listFlows(businessId);
  const resolved = resolveAiFlowByRef(flows, args.flow);
  if (!resolved.ok) return resolved;
  const flow = resolved.flow;

  if (args.confirmationToken !== undefined) {
    return await applyStagedEdit(businessId, flow, args.confirmationToken, {
      consumeEdit,
      persistUpdate,
      ...(deps.editSource !== undefined ? { editSource: deps.editSource } : {}),
      ...(deps.editActor !== undefined ? { editActor: deps.editActor } : {})
    });
  }

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

  const diff = diffFlowDefinitions(flow.definition, compiled.definition, {
    currentName: flow.name,
    ...(args.newName !== undefined ? { newName: args.newName } : {})
  });
  const liveStep = await highestLiveStep(businessId, flow.id);
  const risk = classifyEditRisk(diff, liveStep);

  if (risk === "none") {
    return {
      ok: false,
      message:
        "That instruction produced no change to the automation, so nothing was staged and nothing was applied. Tell the owner it already works that way, or ask what specifically should be different."
    };
  }

  if (surfaceKind === "text" && risk !== "wording") {
    // The line: by text you can change what an automation SAYS; changing
    // what it DOES needs the owner looking at it.
    return {
      ok: false,
      message:
        `This change would alter what the automation DOES (${describeRisk(risk, liveStep)}), not just its wording, and that is not something to approve from a text message. Nothing was changed. Tell the owner the exact change is ready to review at ${dashboardPointer(flow.id)} and that you can apply it from there or from the dashboard chat.`
    };
  }

  let staged;
  try {
    staged = await stageEdit({
      businessId,
      flowId: flow.id,
      definition: compiled.definition,
      newName: args.newName ?? null,
      summary: diff.summary,
      // Layer 4 (blocking questions) fills this; nothing produces one yet,
      // and an empty list is what "no open questions" looks like.
      ambiguities: [],
      risk,
      baseUpdatedAt: flow.updated_at,
      ...(deps.editSource !== undefined ? { surface: deps.editSource } : {}),
      ...(deps.editActor !== undefined ? { actor: deps.editActor } : {})
    });
  } catch (err) {
    logger.warn("edit_aiflow: staging failed", {
      businessId,
      flowId: flow.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "The edit compiled but could not be staged for your confirmation, so NOTHING was changed. Tell the owner it did not go through."
    };
  }

  return {
    ok: true,
    staged: true,
    confirmationToken: staged.token,
    flowId: flow.id,
    flowName: flow.name,
    risk,
    summary: diff.summary,
    note:
      `NOTHING HAS CHANGED YET. Read the summary above back to the owner in your own plain words, including any exact new wording, and ask them to confirm. Only if they clearly say yes, call edit_aiflow again with the SAME flow and instructions plus confirmationToken "${staged.token}". If they say no, or say anything ambiguous, do not call it again and tell them nothing was changed. The staged change expires on its own; never claim it was applied.`
  };
}

function describeRisk(risk: string, liveStep: number | null): string {
  // `in_flight` is only ever reached with a non-null liveStep: the class is
  // defined by the divergence sitting at or before a parked run's index.
  if (risk === "in_flight") {
    return `it adds or removes steps ahead of runs already at step ${liveStep}, which would resume them on the wrong instruction`;
  }
  return "it adds, removes or reorders steps, or changes what starts it";
}

async function applyStagedEdit(
  businessId: string,
  flow: { id: string; name: string; updated_at: string },
  token: string,
  deps: {
    consumeEdit: typeof consumePendingEdit;
    persistUpdate: typeof updateAiFlow;
    editSource?: string;
    editActor?: string | null;
  }
): Promise<EditAiFlowToolResult> {
  const claimed = await deps.consumeEdit(businessId, token);
  if (!claimed.ok) return { ok: false, message: claimed.message };
  const pending = claimed.row;

  if (pending.flow_id !== flow.id) {
    return {
      ok: false,
      message:
        "That confirmation belongs to a different automation, so nothing was changed. Re-describe the change for the automation you mean."
    };
  }

  if (pending.ambiguities.length > 0) {
    return {
      ok: false,
      message: `That change still has unanswered questions (${pending.ambiguities.join("; ")}), so it was NOT applied. Ask the owner those questions, then describe the change again.`
    };
  }

  // The flow moved between staging and confirming: the owner would be
  // approving a diff that no longer describes what is live.
  if (pending.base_updated_at !== flow.updated_at) {
    return {
      ok: false,
      message:
        "The automation changed after that summary was written, so applying it now would overwrite work that happened in between. Nothing was changed. Describe the edit again to get a fresh summary."
    };
  }

  let updated;
  try {
    updated = await deps.persistUpdate({
      businessId,
      id: flow.id,
      definition: pending.definition,
      ...(pending.new_name ? { name: pending.new_name } : {}),
      ...(deps.editSource !== undefined ? { editSource: deps.editSource } : {}),
      ...(deps.editActor !== undefined ? { editActor: deps.editActor } : {})
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
        "The confirmed automation could not be saved, so the flow was NOT changed. Tell the owner to try again."
    };
  }

  return {
    ok: true,
    flowId: updated.id,
    flowName: updated.name,
    enabled: updated.enabled,
    stepCount: pending.definition.steps.length,
    triggerChannel: pending.definition.trigger.channel,
    note: `The automation was updated and the change is live${
      updated.enabled ? "" : " (the flow itself is still disabled)"
    }. Summarize exactly what changed and mention the owner can review it at ${dashboardPointer(updated.id)}, and that "undo that" puts it straight back. Do NOT repeat the JSON definition.`
  };
}
