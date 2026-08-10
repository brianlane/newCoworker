/**
 * AiFlow approval gates answered from Slack.
 *
 * The option model is the SHARED pure module every approval surface uses
 * (supabase/functions/_shared/ai_flows/approval_options.ts): decisions map
 * against the options STORED on the run, never against what today's code
 * would build, and `decideAiFlowApproval` (throws unless awaiting_approval)
 * makes whichever surface answers first win with the others becoming
 * polite no-ops. The free-text modify rewind is a line-for-line port of
 * the SMS webhook's writes (telnyx-sms-inbound), including the
 * resume-marker re-point that keeps the rewind from landing back on the
 * gate.
 *
 * Identity is the caller's job: these functions assume the decider was
 * already verified as the OWNER (the same trust bar as the Telnyx
 * owner-number check and the dashboard session).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { decideAiFlowApproval, getAiFlowRun } from "@/lib/ai-flows/db";
import {
  APPROVAL_OPTION_DECISIONS,
  APPROVAL_OPTION_LABELS,
  approvalModifyForReply,
  approvalOptionForReply,
  parseStoredApprovalOptions,
  parseStoredRedraftStepIndex,
  type ApprovalGateOption
} from "../../../supabase/functions/_shared/ai_flows/approval_options";
import { withResumeMarkerVar } from "../../../supabase/functions/_shared/ai_flows/branching";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Buttons for the approval card, one per option stored on the run. */
export function slackApprovalButtons(input: {
  runId: string;
  options: ApprovalGateOption[];
  allowModify: boolean;
}): unknown[] {
  const elements = input.options.map((option) => ({
    type: "button",
    action_id: `aiflow_approval:${option}`,
    value: JSON.stringify({ r: input.runId, o: option }),
    ...(option === "approve" ? { style: "primary" } : {}),
    ...(option === "cancel" ? { style: "danger" } : {}),
    text: { type: "plain_text", text: APPROVAL_OPTION_LABELS[option] }
  }));
  return [
    { type: "actions", block_id: `aiflow_approval:${input.runId}`, elements },
    ...(input.allowModify
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "To change the draft instead, reply in this thread and mention @New Coworker with what to adjust."
              }
            ]
          }
        ]
      : [])
  ];
}

export type SlackApprovalOutcome =
  | { applied: true; kind: "decision"; option: ApprovalGateOption }
  | { applied: true; kind: "modify" }
  | { applied: false; reason: "already_handled" | "unknown_option" | "not_modifiable" };

/**
 * Apply an enumerated option (a button press, or a digit typed in the
 * approval thread). Validates against the stored option list first, so a
 * stale card from an earlier deploy can never smuggle in an option this
 * run was not offered.
 */
export async function applySlackApprovalDecision(
  input: {
    businessId: string;
    runId: string;
    option: string;
    decidedBy: string;
  },
  client?: SupabaseClient
): Promise<SlackApprovalOutcome> {
  const db = client ?? (await createSupabaseServiceClient());
  const run = await getAiFlowRun(input.businessId, input.runId, db);
  if (!run || run.status !== "awaiting_approval") {
    return { applied: false, reason: "already_handled" };
  }
  const approvalCtx = (run.context as { approval?: { options?: unknown } } | null)?.approval;
  const stored = parseStoredApprovalOptions(approvalCtx?.options);
  const option = stored.find((o) => o === input.option);
  if (!option) return { applied: false, reason: "unknown_option" };

  try {
    await decideAiFlowApproval(
      {
        businessId: input.businessId,
        runId: input.runId,
        decision: APPROVAL_OPTION_DECISIONS[option],
        decidedBy: input.decidedBy
      },
      db
    );
  } catch (err) {
    // Raced another surface (SMS digit, dashboard button): a polite no-op.
    if (err instanceof Error && /not awaiting approval|run not found/.test(err.message)) {
      return { applied: false, reason: "already_handled" };
    }
    throw err;
  }
  return { applied: true, kind: "decision", option };
}

/**
 * Free-text modify from the approval thread. Port of the SMS webhook's
 * rewind: status back to queued at the redraft step, the owner's words in
 * `context.approval.note`, and the resume marker re-pointed at the step we
 * rewind TO (leaving it on the gate would land the resume right back there
 * and silently drop the redraft).
 */
export async function applySlackApprovalModify(
  input: {
    businessId: string;
    runId: string;
    note: string;
    decidedBy: string;
  },
  client?: SupabaseClient
): Promise<SlackApprovalOutcome> {
  const db = client ?? (await createSupabaseServiceClient());
  const run = await getAiFlowRun(input.businessId, input.runId, db);
  if (!run || run.status !== "awaiting_approval") {
    return { applied: false, reason: "already_handled" };
  }
  const approvalCtx = (run.context as {
    approval?: { redraft_step_index?: unknown; redraft_step_id?: unknown };
  } | null)?.approval;
  const modify = approvalModifyForReply(
    parseStoredRedraftStepIndex(approvalCtx?.redraft_step_index),
    input.note
  );
  if (!modify) return { applied: false, reason: "not_modifiable" };

  const redraftStepId =
    typeof approvalCtx?.redraft_step_id === "string" ? approvalCtx.redraft_step_id : null;
  const nextContext = withResumeMarkerVar(
    {
      // Spreading null is a safe no-op, so no fallback object is needed.
      ...(run.context as Record<string, unknown> | null),
      approval: {
        decision: "modify",
        decided_by: input.decidedBy,
        note: modify.note,
        decided_at: new Date().toISOString()
      }
    },
    redraftStepId
  );
  const { data, error } = await db
    .from("ai_flow_runs")
    .update({
      status: "queued",
      current_step: modify.redraftStepIndex,
      context: nextContext,
      claimed_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", input.runId)
    .eq("business_id", input.businessId)
    .eq("status", "awaiting_approval")
    .select("id");
  if (error) throw new Error(`applySlackApprovalModify: ${error.message}`);
  if (((data as Array<{ id: string }> | null) ?? []).length === 0) {
    return { applied: false, reason: "already_handled" };
  }
  return { applied: true, kind: "modify" };
}

/**
 * The awaiting-approval run whose Slack prompt anchors this thread, if any.
 * Matched on channel AND ts: Slack ts values are only unique per channel,
 * so a same-ts thread in another channel must never read as an approval
 * answer. Newest wins when several gates parked into the same channel (the
 * SMS handler's most-recent rule).
 */
export async function findAwaitingApprovalRunBySlackThread(
  businessId: string,
  channelId: string,
  threadTs: string,
  client?: SupabaseClient
): Promise<{ runId: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", "awaiting_approval")
    .eq("context->approval->>slack_channel_id", channelId)
    .eq("context->approval->>slack_message_ts", threadTs)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("findAwaitingApprovalRunBySlackThread: read failed", {
      businessId,
      error: error.message
    });
    return null;
  }
  return data ? { runId: (data as { id: string }).id } : null;
}

/** Owner-facing ack lines, mirroring the SMS handler's wording. */
export function slackApprovalAck(outcome: SlackApprovalOutcome): string {
  if (!outcome.applied) {
    return outcome.reason === "unknown_option"
      ? "That option isn't available for this approval."
      : outcome.reason === "not_modifiable"
        ? "This approval doesn't support edits; use the buttons above."
        : "That request was already handled, no change made.";
  }
  if (outcome.kind === "modify") {
    return "Got it, redoing that with your changes. I'll send the new draft over.";
  }
  switch (outcome.option) {
    case "approve":
      return "Approved, sending it now.";
    case "bypass_quiet_hours":
      return "Approved, sending now, and I'll skip quiet hours for the rest of this workflow.";
    case "skip":
      return "Skipped, I won't send that, but the rest of the workflow continues.";
    default:
      return "Canceled, I stopped the whole workflow.";
  }
}

/** Also parse a bare digit typed in the thread, per the SMS numbering. */
export function slackApprovalOptionForText(
  storedOptions: unknown,
  text: string
): ApprovalGateOption | null {
  return approvalOptionForReply(parseStoredApprovalOptions(storedOptions), text.trim());
}

/**
 * A typed reply in the approval thread: a bare digit maps against the
 * stored options (the SMS numbering), anything else is a free-text modify
 * when the gate declared one. Caller has already verified the OWNER.
 */
export async function answerApprovalFromText(
  input: { businessId: string; runId: string; text: string; decidedBy: string },
  client?: SupabaseClient
): Promise<SlackApprovalOutcome> {
  const db = client ?? (await createSupabaseServiceClient());
  const run = await getAiFlowRun(input.businessId, input.runId, db);
  if (!run || run.status !== "awaiting_approval") {
    return { applied: false, reason: "already_handled" };
  }
  const approvalCtx = (run.context as { approval?: { options?: unknown } } | null)?.approval;
  const digitOption = slackApprovalOptionForText(approvalCtx?.options, input.text);
  if (digitOption) {
    return applySlackApprovalDecision(
      {
        businessId: input.businessId,
        runId: input.runId,
        option: digitOption,
        decidedBy: input.decidedBy
      },
      db
    );
  }
  return applySlackApprovalModify(
    {
      businessId: input.businessId,
      runId: input.runId,
      note: input.text,
      decidedBy: input.decidedBy
    },
    db
  );
}
