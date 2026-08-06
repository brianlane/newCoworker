/**
 * The vocabulary around a `place_ai_call` outcome: WHY it landed that way, and
 * how to say it to a person.
 *
 * The outcome token alone stopped being enough once the dial path grew guards
 * and answering-machine detection. `not_placed` now covers six distinct
 * refusals and `no_answer` three distinct endings, and a flow that alerts an
 * owner needs the difference while a flow that just retries does not. Rather
 * than grow the outcome union (which would mean auditing every existing flow
 * that branches on `no_answer`, including live tenant flows), the outcome
 * stays coarse and two COMPANION vars carry the detail:
 *
 *   {{vars.call_outcome}}         transferred | answered | no_answer |
 *                                 not_placed | failed
 *   {{vars.call_outcome_reason}}  a stable token for gating and telemetry
 *   {{vars.call_outcome_label}}   the same fact as a human phrase, because
 *                                 these get templated into texts a teammate
 *                                 reads, and "Result: no_answer" is not
 *                                 something to send a person
 *
 * This module is the single source of truth for all three, imported by the
 * authoring validator (src/lib/ai-flows), the run tree, the worker, and the
 * call-end webhook, so the names cannot drift between them.
 */

/** Coarse outcomes a `place_ai_call` can resolve to. */
export type PlaceCallOutcomeToken =
  | "transferred"
  | "answered"
  | "no_answer"
  | "not_placed"
  | "failed";

/**
 * Why the call ended the way it did.
 *
 * `voicemail_left` / `voicemail_no_message` both ride a `no_answer` outcome on
 * purpose: reaching a machine is, for retry purposes, the same as nobody
 * picking up, so a ladder written before AMD existed keeps working unchanged.
 */
export const CALL_REASON = {
  /** Machine answered and the AI spoke the step's voicemail script. */
  VOICEMAIL_LEFT: "voicemail_left",
  /** Machine answered but the step configured no voicemail script. */
  VOICEMAIL_NO_MESSAGE: "voicemail_no_message",
  /** The lead has texted STOP (or the owner flagged them). Never dial. */
  OPTED_OUT: "recipient_opted_out",
  /** Too many dials to this number recently, across every flow. */
  DIAL_CAP: "dial_cap",
  /** Step has a callWindow with outside:"skip" and it is closed right now. */
  OUTSIDE_CALL_WINDOW: "outside_call_window",
  /** Business tier does not include outbound AI calls. */
  TIER_BLOCKED: "tier_blocked",
  /** No usable phone number in the step's toVar. */
  NO_CALLEE_PHONE: "no_callee_phone"
} as const;

export type CallOutcomeReason = (typeof CALL_REASON)[keyof typeof CALL_REASON];

/**
 * The two vars a `place_ai_call` step produces alongside its outcome. Derived
 * from the step's own `saveAs` so two call steps in one flow with different
 * outcome vars also get their own reason/label.
 */
export function callOutcomeCompanionVars(outcomeVar: string): [string, string] {
  return [`${outcomeVar}_reason`, `${outcomeVar}_label`];
}

/**
 * The human phrase for an outcome, sharpened by its reason when there is one.
 *
 * Written to be dropped mid-sentence after "The call:" or "We ", so every
 * phrase is lowercase and verb-first. Deliberately says what happened from the
 * READER's point of view (a teammate deciding whether to follow up), not the
 * dialer's: "connected you live" rather than "transfer initiated".
 */
export function callOutcomeLabel(
  outcome: string,
  reason?: string | null
): string {
  if (reason === CALL_REASON.VOICEMAIL_LEFT) return "left them a voicemail";
  if (reason === CALL_REASON.VOICEMAIL_NO_MESSAGE) return "reached their voicemail";
  if (reason === CALL_REASON.OPTED_OUT) return "did not call: they asked us to stop texting";
  if (reason === CALL_REASON.DIAL_CAP) return "did not call: already tried them several times today";
  if (reason === CALL_REASON.OUTSIDE_CALL_WINDOW) return "did not call: outside calling hours";
  if (reason === CALL_REASON.TIER_BLOCKED) return "did not call: outbound calling is not on this plan";
  if (reason === CALL_REASON.NO_CALLEE_PHONE) return "did not call: no usable phone number";
  switch (outcome) {
    case "transferred":
      return "connected you live";
    case "answered":
      return "spoke with them";
    case "no_answer":
      return "no answer yet";
    case "not_placed":
      return "could not place the call";
    case "failed":
      return "the call failed";
    default:
      // An outcome this deploy predates. Say nothing confident about it
      // rather than rendering a raw token into a teammate's text.
      return "call outcome unknown";
  }
}
