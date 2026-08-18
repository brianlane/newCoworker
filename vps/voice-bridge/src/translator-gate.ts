/**
 * Should the AI stay on a bridged call as an interpreter?
 *
 * Being ARMED and NEEDING an interpreter are two different questions, and the
 * bridge used to ask only the first. `stream_bidirectional_target_legs=both` is
 * set at answer time from the tenant column, which answers "can the human hear
 * us". Nothing answered "does anyone here need translating", so every warm
 * transfer on an armed tenant became an interpreted call.
 *
 * THE INCIDENT (Amy Laidlaw, call 5634b7f0, 2026-08-18). An outbound AI seller
 * call reached an English-speaking lead, transferred him to a teammate, and the
 * AI stayed on and started translating English into Spanish for two English
 * speakers. It had no language to work from (`caller_language: null` in the
 * entry telemetry), so the cue's relative wording, "say what they said in the
 * caller's language", left it to invent a pair. The only Spanish-looking thing
 * on the call was a mis-transcribed "¿Tú?".
 *
 * The fleet-wide default-on migration (20260821006000) argued that "the AI
 * already decides to interpret only when someone actually needs it". This
 * module is that claim, implemented.
 *
 * Two sources of truth, in order:
 *   1. the contact's stored `preferred_language`, which is how a known Spanish
 *      caller gets an interpreter from the first second of the call,
 *   2. what the caller has actually said on THIS call, so a first-time caller
 *      (no contact row, no stored language) still gets one. That is the case
 *      the feature was built for, and a stored-preference-only gate would deny
 *      it exactly when it matters.
 *
 * Deliberately kept dependency-free and separate from the bridge runtime so the
 * repo-root test suite can import it.
 */
import type { VoiceCustomerLanguage } from "./customer-language-line.js";
import { detectCustomerLanguage } from "./detect-customer-language.js";

export type InterpretReason =
  | "stored_preference"
  | "detected_in_call"
  | "same_language"
  | "no_language_evidence";

export type InterpretDecision = {
  /** Stay on the bridged call and interpret. */
  engage: boolean;
  /** The caller's language. Never null when `engage` is true. */
  callerLanguage: VoiceCustomerLanguage | null;
  /** The language the teammate who just picked up is expected to speak. */
  colleagueLanguage: VoiceCustomerLanguage;
  reason: InterpretReason;
  /** How many caller turns were weighed. Telemetry, so a skip is diagnosable. */
  turnsConsidered: number;
};

export function resolveInterpretDecision(input: {
  /** contacts.preferred_language for this caller, when we have one. */
  established?: VoiceCustomerLanguage | null;
  /** businesses.default_customer_language: what the colleague speaks. */
  defaultLang?: VoiceCustomerLanguage;
  /** What the caller has said so far on this call, oldest first. */
  callerTurns?: string[];
}): InterpretDecision {
  const colleagueLanguage: VoiceCustomerLanguage = input.defaultLang ?? "en";
  const established = input.established ?? null;
  const turns = (input.callerTurns ?? []).filter((t) => t.trim().length > 0);
  const base = { colleagueLanguage, turnsConsidered: turns.length };

  // In-call evidence is weighed FIRST when it is decisive, because a stored
  // preference can be stale (numbers get reassigned, households share phones)
  // and what someone is speaking right now cannot be.
  for (const text of turns) {
    const detected = detectCustomerLanguage({
      text,
      establishedLanguage: established,
      defaultLanguage: colleagueLanguage
    });
    // "high" is the detector's own bar for a signal it would persist on first
    // contact. Anything softer is how a single mis-transcribed token ("¿Tú?",
    // which scores English/none) or a stray "hola" would get through.
    if (detected.confidence === "high" && detected.language !== colleagueLanguage) {
      return {
        ...base,
        engage: true,
        callerLanguage: detected.language,
        reason: "detected_in_call"
      };
    }
  }

  if (established && established !== colleagueLanguage) {
    return { ...base, engage: true, callerLanguage: established, reason: "stored_preference" };
  }

  return {
    ...base,
    engage: false,
    callerLanguage: null,
    // Two different "no" answers, because they need different follow-up: one
    // says the two parties share a language, the other says we never heard
    // enough to tell. Only the second is worth revisiting.
    reason: established === colleagueLanguage ? "same_language" : "no_language_evidence"
  };
}
