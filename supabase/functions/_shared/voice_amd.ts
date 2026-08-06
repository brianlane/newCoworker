/**
 * Answering-machine detection verdicts, as pure decisions.
 *
 * Telnyx answers an outbound leg whether a person or a voicemail picks up, so
 * without AMD the two are indistinguishable downstream: the outcome derived
 * from `answer_issued_at` reads "answered" either way, and a follow-up ladder
 * written to retry until someone is actually reached stops on a lead who never
 * heard a word.
 *
 * The two tiers do NOT share a result vocabulary, which is the trap this
 * module exists to contain:
 *
 *   standard (`detect`)  human | machine | not_sure
 *   premium  (`premium`) human_residence | human_business | machine |
 *                        silence | fax_detected | not_sure
 *
 * Premium never returns the bare string "human". Code that tests for it
 * directly would classify every live person as not-a-human and, on a flow that
 * leaves voicemails, read a script at them. Both vocabularies are handled here
 * so no caller has to know which mode a connection is in.
 */

/** What the caller should do with a detection verdict. */
export type AmdVerdict =
  /** A person is on the line. Carry on with the call. */
  | "human"
  /** A machine picked up. */
  | "machine"
  /**
   * Telnyx could not tell (silence, a fax tone, or an explicit not_sure).
   * Deliberately its own verdict rather than folded into either side: hanging
   * up on a maybe-person is rude, and reading a voicemail script at one is
   * worse, so callers should carry on with the call and treat it as human.
   */
  | "unknown";

const HUMAN_RESULTS = new Set(["human", "human_residence", "human_business"]);
const MACHINE_RESULTS = new Set(["machine"]);

/**
 * Classify a `call.machine.*detection.ended` result.
 *
 * Anything unrecognized lands on "unknown" rather than "machine", so a result
 * value Telnyx adds later cannot start silently hanging up on people.
 */
export function classifyAmdResult(result: unknown): AmdVerdict {
  const value = typeof result === "string" ? result.trim().toLowerCase() : "";
  if (HUMAN_RESULTS.has(value)) return "human";
  if (MACHINE_RESULTS.has(value)) return "machine";
  return "unknown";
}

/** Event types carrying a human-or-machine verdict, both tiers. */
export const AMD_DETECTION_EVENTS: ReadonlySet<string> = new Set([
  "call.machine.detection.ended",
  "call.machine.premium.detection.ended"
]);

/**
 * Event types fired when a voicemail's outgoing greeting has finished, i.e.
 * the moment it is safe to start speaking. Routed and recognized now so the
 * dispatch table and this vocabulary stay together, though nothing speaks yet.
 */
export const AMD_GREETING_EVENTS: ReadonlySet<string> = new Set([
  "call.machine.greeting.ended",
  "call.machine.premium.greeting.ended"
]);

/** True for any answering-machine detection event, either tier. */
export function isAmdEvent(eventType: string): boolean {
  return AMD_DETECTION_EVENTS.has(eventType) || AMD_GREETING_EVENTS.has(eventType);
}
