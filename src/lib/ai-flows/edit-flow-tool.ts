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
import {
  consumePendingEdit,
  peekPendingEdit,
  stagePendingEdit
} from "@/lib/ai-flows/pending-edits";
import { announceFlowChange } from "@/lib/ai-flows/change-notice";
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
  peekEdit?: typeof peekPendingEdit;
  announce?: typeof announceFlowChange;
  /** Defaults to "rich"; the SMS and email surfaces pass "text". */
  surfaceKind?: EditSurfaceKind;
  editSource?: string;
  editActor?: string | null;
};

export type EditAiFlowToolResult =
  | {
      ok: true;
      staged: false;
      /** Open questions the owner must answer before anything can be staged. */
      questions: string[];
      flowId: string;
      flowName: string;
      note: string;
    }
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
      /**
       * The ONLY shape that wrote to ai_flows. inline-turn keys its
       * side-effect pin on this rather than on `ok`, because staging also
       * succeeds while changing nothing, and a degraded wrap-up must never
       * tell the owner an automation was updated when it was only described.
       */
      applied: true;
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
  const peekEdit = deps.peekEdit ?? peekPendingEdit;
  const announce = deps.announce ?? announceFlowChange;
  const surfaceKind = deps.surfaceKind ?? "rich";
  /* c8 ignore stop */

  const flows = await listFlows(businessId);
  const resolved = resolveAiFlowByRef(flows, args.flow);
  if (!resolved.ok) return resolved;
  const flow = resolved.flow;

  if (args.confirmationToken !== undefined) {
    return await applyStagedEdit(businessId, flow, args.confirmationToken, {
      consumeEdit,
      peekEdit,
      persistUpdate,
      announce,
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

  // Layer 4: what the compile had to GUESS blocks staging outright. No token
  // is issued, so the model cannot reach the apply call at all until the
  // owner has answered. This inverts the default from "act unless unsure"
  // to "cannot act until resolved".
  const questions = compiled.questions ?? [];
  if (questions.length > 0) {
    return {
      ok: true,
      staged: false,
      questions,
      flowId: flow.id,
      flowName: flow.name,
      note: `NOTHING HAS CHANGED, and nothing is staged. Working out this change meant guessing about the points listed in questions. Ask the owner those questions in your own words, in one short message, and when they answer, call edit_aiflow again with their answers folded into the instructions. Do not guess on their behalf, and do not ask for confirmation of a change you have not described yet.`
    };
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
        `This change would alter what the automation DOES (${describeRisk(risk, liveStep)}), not just its wording, and that is not something to approve from a text message. NOTHING was changed and nothing was saved anywhere, so there is no pending change waiting. Tell the owner plainly that this one needs to be made where they can see the whole automation: ${dashboardPointer(flow.id)}, or by asking you again from the dashboard chat.`
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
      // Always empty by construction: a compile that produced questions
      // returned above without staging. Kept as a column and re-checked at
      // confirm time as defense in depth, so a row that somehow carries one
      // can never be applied.
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
  if (risk === "behavioral") {
    return "it changes what a step DOES on a web page, or whether a step runs at all, which cannot be checked from the sentence describing it";
  }
  return "it adds, removes or reorders steps, or changes what starts it";
}

async function applyStagedEdit(
  businessId: string,
  flow: { id: string; name: string; updated_at: string },
  token: string,
  deps: {
    consumeEdit: typeof consumePendingEdit;
    peekEdit: typeof peekPendingEdit;
    persistUpdate: typeof updateAiFlow;
    announce: typeof announceFlowChange;
    editSource?: string;
    editActor?: string | null;
  }
): Promise<EditAiFlowToolResult> {
  // Check BEFORE claiming. The token is single use, so validating after the
  // claim would burn it on a refusal that wrote nothing, and the owner would
  // be told to try again by a path that can no longer succeed.
  const peeked = await deps.peekEdit(businessId, token);
  // Only a row that is still claimable gets these checks. A row that was
  // ALREADY consumed must fall through to the claim, which diagnoses it as
  // "already applied once": after a successful apply the flow's updated_at
  // has moved, so the freshness check below would otherwise fire first and
  // report that nothing was applied and the flow changed underneath, which
  // steers the model into re-staging a change that already landed.
  //
  // An expired row is left to fall through here too, but harmlessly: its
  // advice ("describe the edit again to get a fresh summary") is the same
  // either way.
  if (peeked !== null && peeked.consumed_at === null) {
    if (peeked.flow_id !== flow.id) {
      return {
        ok: false,
        message:
          "That confirmation belongs to a different automation, so nothing was changed. Re-describe the change for the automation you mean."
      };
    }
    if (peeked.ambiguities.length > 0) {
      return {
        ok: false,
        message: `That change still has unanswered questions (${peeked.ambiguities.join("; ")}), so it was NOT applied. Ask the owner those questions, then describe the change again.`
      };
    }
    // The flow moved between staging and confirming: the owner would be
    // approving a diff that no longer describes what is live.
    if (peeked.base_updated_at !== flow.updated_at) {
      return {
        ok: false,
        message:
          "The automation changed after that summary was written, so applying it now would overwrite work that happened in between. Nothing was changed. Describe the edit again to get a fresh summary."
      };
    }
  }

  // Claim last, immediately before the write. An unknown, replayed or
  // expired token is diagnosed here.
  const claimed = await deps.consumeEdit(businessId, token);
  if (!claimed.ok) return { ok: false, message: claimed.message };
  const pending = claimed.row;

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
    // The confirmation is spent even though nothing was written. Say so
    // rather than inviting a retry that would come back "already applied":
    // releasing the claim instead would race a concurrent confirm that has
    // already been told the change landed.
    return {
      ok: false,
      message:
        "The confirmed automation could not be saved, so the flow was NOT changed, and that confirmation is now used up. Tell the owner it did not go through and describe the change again to get a fresh summary to approve."
    };
  }

  // Out of band, after the write: the owner should still know tomorrow, when
  // the conversation this was approved in has scrolled away. Never awaited
  // for its result beyond completion, and never able to fail the change.
  await deps.announce({
    businessId,
    flowId: updated.id,
    flowName: updated.name,
    action: "edited",
    source: deps.editSource,
    actor: deps.editActor ?? null,
    summary: pending.summary
  });

  return {
    ok: true,
    applied: true,
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
