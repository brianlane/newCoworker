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
 * Two sources of truth, and the live call outranks the stored one in BOTH
 * directions:
 *   1. what the caller has actually said on THIS call. It is the only evidence
 *      a first-time caller has (no contact row, no stored language), which is
 *      the case the feature was built for, and it is also what catches a stored
 *      language that has gone stale.
 *   2. the contact's stored `preferred_language`, which covers the transfer
 *      that happens before they have said enough to judge.
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

  // In-call evidence outranks the stored preference in BOTH directions,
  // because a stored language can be stale (numbers get reassigned, households
  // share phones, people are bilingual) and what someone is speaking right now
  // cannot be.
  //
  // "high" is the detector's own bar for a signal it would persist on first
  // contact. Anything softer is how a single mis-transcribed token ("¿Tú?",
  // which scores English with confidence "none") or a stray "hola" gets in.
  let heardColleagueLanguage = false;
  for (const text of turns) {
    const detected = detectCustomerLanguage({
      text,
      establishedLanguage: established,
      defaultLanguage: colleagueLanguage
    });
    if (detected.confidence !== "high") continue;
    // Someone who switches into another language for the substance of their
    // call needs the interpreter, whatever they opened with, so a single
    // decisive turn wins over any number of same-language ones.
    if (detected.language !== colleagueLanguage) {
      return {
        ...base,
        engage: true,
        callerLanguage: detected.language,
        reason: "detected_in_call"
      };
    }
    heardColleagueLanguage = true;
  }

  // Heard speaking the colleague's language, clearly, and never anything else:
  // no interpreter, whatever the contact row says. Without this a bilingual
  // contact filed as Spanish gets one wedged into a conversation both people
  // are having comfortably in English.
  if (heardColleagueLanguage) {
    return { ...base, engage: false, callerLanguage: null, reason: "same_language" };
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
