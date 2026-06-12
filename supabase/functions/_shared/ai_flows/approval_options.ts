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
 *     in between — never re-numbering approve, and never letting a stale
 *     muscle-memory "last digit" approve something destructive.
 *   - The inbound webhook maps a digit against the options STORED on the run
 *     (what the owner was actually offered), not against whatever list the
 *     current code would build — so a deploy mid-approval can't reinterpret
 *     a reply.
 *
 * Used by ai-flow-worker (build + prompt), telnyx-sms-inbound (parse), and
 * the dashboard (src/lib/ai-flows + AiFlowRunsManager) via direct import.
 */

export type ApprovalGateOption = "approve" | "skip" | "bypass_quiet_hours" | "cancel";

/** Owner-facing instruction fragment per option ("Reply N to <this>"). */
export const APPROVAL_OPTION_INSTRUCTIONS: Record<ApprovalGateOption, string> = {
  approve: "approve",
  skip: "skip this step",
  bypass_quiet_hours: "approve and skip quiet hours for the rest of this workflow",
  cancel: "cancel the workflow"
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
 * "Reply 1 to approve, 2 to skip this step, … or N to cancel the workflow."
 */
export function approvalSmsInstruction(options: ApprovalGateOption[]): string {
  const parts = options.map(
    (opt, i) => `${i + 1} to ${APPROVAL_OPTION_INSTRUCTIONS[opt]}`
  );
  if (parts.length === 1) return `Reply ${parts[0]}.`;
  return `Reply ${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}.`;
}

/**
 * Parse the option list stored on a run's `context.approval.options`. Unknown
 * or malformed entries invalidate the whole list (falls back to the legacy
 * 1/2/3 offer) — a half-parsed list would silently renumber the digits the
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
