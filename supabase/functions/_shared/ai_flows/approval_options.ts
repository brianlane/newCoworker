/**
 * Dynamic approval-gate reply options (pure, no IO).
 *
 * An approval gate used to hard-code "1 approve / 2 skip / 3 cancel". Options
 * are now a LIST decided per gate at park time, persisted on the run
 * (`context.approval.options`), and rendered/parsed from that single list so
 * the SMS prompt, the inbound digit parser, and the dashboard buttons can
 * never disagree on numbering. Two invariants:
 *
 *   - "approve" is always first (reply 1) and "cancel" is ALWAYS LAST, so its
 *     digit shifts as optional decisions (e.g. bypass quiet hours) are added
 *     in between, never re-numbering approve, and never letting a stale
 *     muscle-memory "last digit" approve something destructive.
 *   - The inbound webhook maps a digit against the options STORED on the run
 *     (what the owner was actually offered), not against whatever list the
 *     current code would build, so a deploy mid-approval can't reinterpret
 *     a reply.
 *
 * Used by ai-flow-worker (build + prompt), telnyx-sms-inbound (parse), and
 * the dashboard (src/lib/ai-flows + AiFlowRunsManager) via direct import.
 */

export type ApprovalGateOption = "approve" | "skip" | "bypass_quiet_hours" | "cancel";

/**
 * Owner-facing instruction fragment per option ("Reply N to <this>").
 *
 * `skip` and `cancel` read as near-synonyms to an owner deciding in five
 * seconds on a phone, and the difference is real: skip drops ONLY the step
 * this gate guards and lets the rest of the workflow finish (on the HQ inbox
 * flow that means the reply is not sent but the email is still filed), while
 * cancel stops the whole run. Say which, rather than leaving the owner to
 * infer it.
 */
export const APPROVAL_OPTION_INSTRUCTIONS: Record<ApprovalGateOption, string> = {
  approve: "approve",
  skip: "skip just this step and let the rest of the workflow finish",
  bypass_quiet_hours: "approve and skip quiet hours for the rest of this workflow",
  cancel: "stop the whole workflow"
};

/** Dashboard button label per option. */
export const APPROVAL_OPTION_LABELS: Record<ApprovalGateOption, string> = {
  approve: "Approve",
  skip: "Skip step",
  bypass_quiet_hours: "Approve + bypass quiet hours",
  cancel: "Cancel workflow"
};

/**
 * Decision value each option resolves to (`context.approval.decision` /
 * decideAiFlowApproval). "cancel" keeps the legacy "deny" decision name so
 * existing run records and the decide paths stay compatible.
 */
export const APPROVAL_OPTION_DECISIONS = {
  approve: "approve",
  skip: "skip",
  bypass_quiet_hours: "bypass_quiet_hours",
  cancel: "deny"
} as const satisfies Record<ApprovalGateOption, string>;

export type ApprovalGateDecision =
  (typeof APPROVAL_OPTION_DECISIONS)[ApprovalGateOption];

/** The pre-options legacy offer (runs parked before options were stored). */
export const LEGACY_APPROVAL_OPTIONS: ApprovalGateOption[] = ["approve", "skip", "cancel"];

/**
 * Build the ordered option list for one gate. Approve and skip always lead;
 * optional decisions slot in between; cancel is appended LAST so it always
 * takes the highest digit.
 */
export function buildApprovalGateOptions(opts: {
  /** Offer "bypass quiet hours" (any later send_sms step has quiet hours). */
  offerQuietBypass: boolean;
}): ApprovalGateOption[] {
  const out: ApprovalGateOption[] = ["approve", "skip"];
  if (opts.offerQuietBypass) out.push("bypass_quiet_hours");
  out.push("cancel");
  return out;
}

/**
 * "Reply 1 to approve, 2 to skip just this step, … or N to stop the whole
 * workflow." When the gate accepts a modification, the text says so: the
 * capability shipped invisible otherwise, since an owner has no way to guess
 * that free text does anything from a list of numbers.
 */
export function approvalSmsInstruction(
  options: ApprovalGateOption[],
  opts: { allowModify?: boolean } = {}
): string {
  const parts = options.map(
    (opt, i) => `${i + 1} to ${APPROVAL_OPTION_INSTRUCTIONS[opt]}`
  );
  const numbered =
    parts.length === 1
      ? `Reply ${parts[0]}.`
      : `Reply ${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}.`;
  return opts.allowModify ? `${numbered} Or just tell me what to change.` : numbered;
}

/**
 * Parse the option list stored on a run's `context.approval.options`. Unknown
 * or malformed entries invalidate the whole list (falls back to the legacy
 * 1/2/3 offer), a half-parsed list would silently renumber the digits the
 * owner was shown.
 */
export function parseStoredApprovalOptions(raw: unknown): ApprovalGateOption[] {
  if (!Array.isArray(raw) || raw.length === 0) return LEGACY_APPROVAL_OPTIONS;
  const known = new Set<string>(Object.keys(APPROVAL_OPTION_INSTRUCTIONS));
  const out: ApprovalGateOption[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !known.has(item)) return LEGACY_APPROVAL_OPTIONS;
    out.push(item as ApprovalGateOption);
  }
  return out;
}

/**
 * Map an owner's SMS digit reply to the option they were offered, or null
 * when the reply isn't a digit within the offered range.
 */
export function approvalOptionForReply(
  options: ApprovalGateOption[],
  reply: string
): ApprovalGateOption | null {
  const trimmed = reply.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const idx = Number(trimmed) - 1;
  return idx >= 0 && idx < options.length ? options[idx] : null;
}

/** Highest digit any gate can currently offer (webhook fast-path guard). */
export const APPROVAL_MAX_REPLY_DIGIT = Object.keys(APPROVAL_OPTION_INSTRUCTIONS).length;

/**
 * Read back the rewind target the worker stored on `context.approval` when a
 * modify-capable gate parked, or null when this gate offered no modification.
 *
 * A step INDEX, not the authored step id: the webhook re-queues the run by
 * setting `current_step`, and resolving the id would mean loading the flow
 * definition on the inbound path. Persisting it at park time also keeps the
 * same invariant the option list has, that the webhook acts on what the owner
 * was ACTUALLY offered rather than on what today's code would build.
 *
 * Anything that is not a non-negative integer disables modification instead of
 * rewinding somewhere invented: a bad index would park the run at a step that
 * cannot resume it.
 */
export function parseStoredRedraftStepIndex(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** What an owner's free-text answer to a modify-capable gate resolves to. */
export type ApprovalModify = { redraftStepIndex: number; note: string };

/**
 * Decide whether an owner's reply is a MODIFICATION rather than a numbered
 * choice, and carry the instruction along with where to rewind to.
 *
 * Returns null when the gate offered no modification, when the reply is a bare
 * digit (that belongs to `approvalOptionForReply`, and the digit vocabulary is
 * globally ordered across claim/pass/unclaim/approve, so a modify branch that
 * ate one would break every existing approval), or when there is nothing to
 * act on.
 */
export function approvalModifyForReply(
  redraftStepIndex: number | null,
  reply: string
): ApprovalModify | null {
  if (redraftStepIndex === null) return null;
  const note = reply.trim();
  if (!note) return null;
  // Same digit rule the owner-reply relay uses (_shared/contact_reply_mode.ts
  // isRelayableOwnerReply), stated here too because this module is imported by
  // the worker as well as the webhook.
  if (/^\d{1,2}$/.test(note)) return null;
  return { redraftStepIndex, note };
}
