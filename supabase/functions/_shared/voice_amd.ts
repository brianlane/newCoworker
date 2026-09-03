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

/** What a greeting event means for a leg, given what is already known about it. */
export type GreetingVerdict =
  /**
   * Apple call screening announced itself earlier and its prompt has now
   * ended: a live PERSON is deciding whether to pick up. Cancel the
   * provisional machine verdict and leave the call alone.
   */
  | "screening_person"
  /**
   * The greeting has finished on a machine. This is the moment to act: leave
   * the configured message, or hang up when there is none.
   */
  | "machine_resolved"
  /** Nothing actionable: no verdict, no beep, nothing proven either way. */
  | "noted";

/**
 * Decide what a greeting event means. The whole subtlety of the iOS mode
 * lives here, so it is testable and in one place.
 *
 * TWO traps, both from real calls:
 *
 * 1. `prompt_ended` is NOT exclusive to Apple call screening. Telnyx fires it
 *    whenever the prompt that followed a machine verdict ends WITHOUT a beep,
 *    and an ordinary voicemail greeting does exactly that: it is the first
 *    pause in the greeting speech, not the beep. Reading it as "a person is
 *    screening" cancelled a CORRECT machine verdict on Jennifer Kline's
 *    mailbox (2026-08-17 16:08Z). The only proof a person is deciding is a
 *    real `call_screening.detected` event (`screeningDetected`). Without it,
 *    do NOT clear the stamp.
 *
 * 2. Resolving a stamped machine on `prompt_ended` (or `no_beep_detected`) and
 *    speaking immediately is the next failure. Five Amy Laidlaw calls in late
 *    Aug / early Sep 2026 spoke 1 to 3s after `prompt_ended`; the real beep
 *    arrived 7 to 22s later; Telnyx cancelled the speak (`cancelled_amd`) and
 *    the handler hung up, so nothing was recorded. `no_beep_detected` arrives
 *    at +24 to +26s, inside Telnyx's default 30s iOS screening window, and
 *    speaking then still hangs up on a live screen (Robert, 2026-09-02).
 *
 * Only `beep_detected` is the moment to speak. Everything else, including a
 * stamped machine whose greeting paused, is `noted`: keep the stamp, wait.
 *
 * A beep still resolves regardless of screening: a screened call that rolls to
 * voicemail ends at a beep like any other.
 *
 * `machineStamped` stays on the state object because callers already have it
 * and tests pin the Jennifer shape (stamped, not screened). It no longer
 * drives the decision: a stamp without a beep is exactly the wait.
 */
export function classifyGreetingEvent(
  result: unknown,
  state: { machineStamped: boolean; screeningDetected: boolean }
): GreetingVerdict {
  const value = typeof result === "string" ? result.trim().toLowerCase() : "";
  if (value === "prompt_ended" && state.screeningDetected) return "screening_person";
  if (greetingImpliesMachine(value)) return "machine_resolved";
  return "noted";
}
