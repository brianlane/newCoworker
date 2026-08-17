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

/**
 * Fired by the `premium_ios_call_screening_detection` mode when Apple's call
 * screening answered the leg (result "screening"). NOT a verdict: a live
 * person is deciding whether to take the call, so it must never be read as
 * machine evidence. The bridge's outbound persona answers the screening
 * prompt with one identification sentence; this event exists so the platform
 * can record that screening happened (and so the dispatch table has a home
 * for it rather than dropping it).
 */
export const AMD_SCREENING_EVENTS: ReadonlySet<string> = new Set([
  "call.machine.premium.call_screening.detected"
]);

/** True for any answering-machine detection event, either tier. */
export function isAmdEvent(eventType: string): boolean {
  return (
    AMD_DETECTION_EVENTS.has(eventType) ||
    AMD_GREETING_EVENTS.has(eventType) ||
    AMD_SCREENING_EVENTS.has(eventType)
  );
}

/**
 * Greeting results that are, on their own, evidence a MACHINE answered.
 *
 * Telnyx documents `detection.ended` as always preceding `greeting.ended`, so
 * in principle the verdict is known by the time a greeting event arrives and
 * this is redundant. It exists anyway because the cost of that ordering
 * guarantee not holding is precisely the bug this module was written to fix:
 * a voicemail silently reported as an answered call. Treating a beep as its
 * own evidence removes the dependency on the ordering entirely.
 *
 * `beep_detected` only: a recorded greeting ending in a beep is a voicemail.
 * `prompt_ended` is deliberately EXCLUDED, since it belongs to iOS call
 * screening, where a live person is deciding whether to take the call.
 */
const MACHINE_GREETING_RESULTS = new Set(["beep_detected"]);

/**
 * Does this greeting event, by itself, prove a machine answered? Used as a
 * backstop when no detection verdict has been recorded for the call yet.
 */
export function greetingImpliesMachine(result: unknown): boolean {
  const value = typeof result === "string" ? result.trim().toLowerCase() : "";
  return MACHINE_GREETING_RESULTS.has(value);
}
