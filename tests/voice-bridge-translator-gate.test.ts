import { describe, expect, it } from "vitest";
import { resolveInterpretDecision } from "../vps/voice-bridge/src/translator-gate";

/**
 * The gate that decides whether a successful warm transfer should leave the AI
 * on the line as an interpreter.
 *
 * THE INCIDENT (Amy Laidlaw, call 5634b7f0, 2026-08-18). An outbound AI seller
 * call reached an English-speaking lead, transferred him to Dave Lane, and the
 * bridge then entered translator mode because the ONLY condition was the
 * tenant's `translator_mode_enabled` column. Nothing asked whether anyone
 * needed an interpreter. With no language known, the cue told the model to
 * translate between two unnamed languages, so it invented a pair: it answered
 * Dave's "Hello. Hello." with "Hola. ¿Hola?" and the call died 63 seconds
 * later. Telemetry recorded the entry with `caller_language: null`.
 *
 * The lead's one Spanish-looking turn was "¿Tú?", a mis-transcription. That is
 * why this gate leans on the SHARED detector rather than a new heuristic: the
 * shared one already scores a lone accented token as English with confidence
 * "none", which is exactly the judgment that was missing.
 *
 * The migration that turned translator mode on fleet-wide
 * (20260821006000_translator_mode_default_on.sql) justified itself with "the AI
 * already decides to interpret only when someone actually needs it". These
 * tests are that sentence, made true.
 */
describe("resolveInterpretDecision", () => {
  /** The caller's turns from call 5634b7f0, verbatim, in order. */
  const AUG_18_CALL = [
    "¿Tú?",
    "What is your offer?",
    "If you can make it quick."
  ];

  it("does not interpret for the Aug 18 English call that started this", () => {
    const decision = resolveInterpretDecision({
      established: null,
      defaultLang: "en",
      callerTurns: AUG_18_CALL
    });
    expect(decision.engage).toBe(false);
    expect(decision.callerLanguage).toBeNull();
    expect(decision.reason).toBe("no_language_evidence");
  });

  it("never engages on a single mis-transcribed token", () => {
    // "¿Tú?" carries Spanish punctuation and nothing else. One stray token is
    // exactly the shape an ASR slip takes, and it must not commit the rest of
    // a live call to being interpreted.
    expect(
      resolveInterpretDecision({ defaultLang: "en", callerTurns: ["¿Tú?"] }).engage
    ).toBe(false);
  });

  it("never engages on greetings and courtesies alone", () => {
    // A caller who opens with "hola" and continues in English is an English
    // caller. The shared detector already treats loanwords this way.
    const decision = resolveInterpretDecision({
      defaultLang: "en",
      callerTurns: ["Hola", "Gracias", "I need to talk to someone about my house"]
    });
    expect(decision.engage).toBe(false);
  });

  it("engages when the caller genuinely speaks the other language", () => {
    const decision = resolveInterpretDecision({
      established: null,
      defaultLang: "en",
      callerTurns: ["Hola, necesito hablar con alguien sobre mi casa"]
    });
    expect(decision.engage).toBe(true);
    expect(decision.callerLanguage).toBe("es");
    expect(decision.colleagueLanguage).toBe("en");
    expect(decision.reason).toBe("detected_in_call");
  });

  it("engages on the contact's stored language before anyone has spoken", () => {
    // The interpreter has to be armed at the transfer, and a known Spanish
    // contact should not have to re-prove it every call.
    const decision = resolveInterpretDecision({
      established: "es",
      defaultLang: "en",
      callerTurns: []
    });
    expect(decision.engage).toBe(true);
    expect(decision.callerLanguage).toBe("es");
    expect(decision.reason).toBe("stored_preference");
  });

  it("does not engage when the stored language IS the business language", () => {
    // Two English speakers need no interpreter, which is the whole defect.
    const decision = resolveInterpretDecision({
      established: "en",
      defaultLang: "en",
      callerTurns: ["What is your offer?"]
    });
    expect(decision.engage).toBe(false);
    expect(decision.reason).toBe("same_language");
  });

  it("lets what the caller actually says override a wrong stored language", () => {
    // Numbers get reassigned and households share phones. The live call is
    // better evidence than a row written weeks ago.
    const decision = resolveInterpretDecision({
      established: "en",
      defaultLang: "en",
      callerTurns: ["No hablo inglés, quiero vender mi casa"]
    });
    expect(decision.engage).toBe(true);
    expect(decision.callerLanguage).toBe("es");
    expect(decision.reason).toBe("detected_in_call");
  });

  it("declines when a stored Spanish contact is plainly speaking English", () => {
    // The mirror of the override above, and the same principle: the live call
    // outranks a row written weeks ago. Without this, a bilingual contact
    // filed as Spanish gets an interpreter wedged into a conversation both
    // people are having comfortably in English.
    const decision = resolveInterpretDecision({
      established: "es",
      defaultLang: "en",
      callerTurns: ["I want to book an appointment for Friday please"]
    });
    expect(decision.engage).toBe(false);
    expect(decision.reason).toBe("same_language");
  });

  it("still engages when they used both languages on the call", () => {
    // Someone who switches into Spanish for the substance needs the
    // interpreter, whatever they opened with.
    const decision = resolveInterpretDecision({
      established: null,
      defaultLang: "en",
      callerTurns: [
        "I want to book an appointment for Friday please",
        "Perdón, necesito hablar con alguien sobre mi casa"
      ]
    });
    expect(decision.engage).toBe(true);
    expect(decision.callerLanguage).toBe("es");
  });

  it("works in the other direction, for a Spanish-speaking business", () => {
    // The colleague's language is the tenant default, not a hardcoded English.
    const decision = resolveInterpretDecision({
      established: null,
      defaultLang: "es",
      callerTurns: ["I want to book an appointment for Friday please"]
    });
    expect(decision.engage).toBe(true);
    expect(decision.callerLanguage).toBe("en");
    expect(decision.colleagueLanguage).toBe("es");
  });

  it("treats an empty or silent call as no evidence", () => {
    for (const turns of [[], [""], ["   "]]) {
      const decision = resolveInterpretDecision({ defaultLang: "en", callerTurns: turns });
      expect(decision.engage).toBe(false);
      expect(decision.reason).toBe("no_language_evidence");
    }
  });

  it("defaults the business language to English when the tenant has none", () => {
    const decision = resolveInterpretDecision({ callerTurns: ["Hola, quiero vender mi casa"] });
    expect(decision.colleagueLanguage).toBe("en");
    expect(decision.engage).toBe(true);
  });

  it("reports how many turns it weighed, so a skip is diagnosable", () => {
    // The incident was only diagnosable because the entry was in telemetry.
    // A skip has to be equally visible or the next report is "it just detached".
    const decision = resolveInterpretDecision({
      defaultLang: "en",
      callerTurns: AUG_18_CALL
    });
    expect(decision.turnsConsidered).toBe(3);
  });
});
