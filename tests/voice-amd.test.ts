import { describe, expect, it } from "vitest";
import {
  AMD_DETECTION_EVENTS,
  AMD_GREETING_EVENTS,
  AMD_SCREENING_EVENTS,
  classifyGreetingEvent,
  classifyAmdResult,
  greetingImpliesMachine,
  isAmdEvent
} from "../supabase/functions/_shared/voice_amd";
import { TELNYX_VOICE_ROUTES } from "../supabase/functions/_shared/telnyx_voice_dispatch";

/**
 * The premium and standard AMD tiers do not share a result vocabulary, and
 * getting that wrong is not a cosmetic bug: premium never returns the bare
 * string "human", so code testing for it directly would classify every live
 * person as not-a-human and, on a flow that leaves voicemails, read a script
 * at them.
 */

describe("classifyAmdResult", () => {
  it("recognizes a person in BOTH vocabularies", () => {
    // Standard.
    expect(classifyAmdResult("human")).toBe("human");
    // Premium, which has no bare "human" result at all.
    expect(classifyAmdResult("human_residence")).toBe("human");
    expect(classifyAmdResult("human_business")).toBe("human");
  });

  it("recognizes a machine", () => {
    expect(classifyAmdResult("machine")).toBe("machine");
  });

  // Hanging up on a maybe-person is rude; reading a voicemail script at one is
  // worse. Both stay "unknown" so the caller carries on with the call.
  it.each(["not_sure", "silence", "fax_detected"])(
    "treats %s as unknown rather than a machine",
    (result) => {
      expect(classifyAmdResult(result)).toBe("unknown");
    }
  );

  // A value Telnyx adds later must not start silently hanging up on people.
  it("fails safe on an unrecognized, empty, or non-string result", () => {
    expect(classifyAmdResult("something_new")).toBe("unknown");
    expect(classifyAmdResult("")).toBe("unknown");
    expect(classifyAmdResult(undefined)).toBe("unknown");
    expect(classifyAmdResult(null)).toBe("unknown");
    expect(classifyAmdResult(42)).toBe("unknown");
  });

  it("tolerates casing and surrounding whitespace", () => {
    expect(classifyAmdResult("  MACHINE ")).toBe("machine");
    expect(classifyAmdResult("Human_Business")).toBe("human");
  });
});

describe("AMD event vocabulary", () => {
  it("covers both tiers for detection and greeting", () => {
    expect([...AMD_DETECTION_EVENTS].sort()).toEqual([
      "call.machine.detection.ended",
      "call.machine.premium.detection.ended"
    ]);
    expect([...AMD_GREETING_EVENTS].sort()).toEqual([
      "call.machine.greeting.ended",
      "call.machine.premium.greeting.ended"
    ]);
  });

  it("classifies membership", () => {
    expect(isAmdEvent("call.machine.premium.detection.ended")).toBe(true);
    expect(isAmdEvent("call.machine.greeting.ended")).toBe(true);
    expect(isAmdEvent("call.answered")).toBe(false);
    expect(isAmdEvent("")).toBe(false);
  });

  // The names use a DOT before "ended", not an underscore. An underscore
  // subscribes to an event Telnyx never sends, and the only symptom would be
  // AMD appearing to work while no verdict ever arrives.
  it("spells every event with dotted segments", () => {
    for (const e of [...AMD_DETECTION_EVENTS, ...AMD_GREETING_EVENTS]) {
      expect(e).not.toContain("_ended");
      expect(e.endsWith(".ended")).toBe(true);
    }
  });

  // A recognized event that is not routed is dropped before it can be handled.
  it("routes every AMD event to the call-end function", () => {
    for (const e of [...AMD_DETECTION_EVENTS, ...AMD_GREETING_EVENTS, ...AMD_SCREENING_EVENTS]) {
      expect(TELNYX_VOICE_ROUTES[e], `${e} must be routed`).toBe("telnyx-voice-call-end");
    }
  });

  // Apple call screening answered (premium_ios_call_screening_detection). A
  // live person is deciding whether to pick up, so the event is recognized
  // for routing and MUST NOT read as a verdict: classifying "screening" as a
  // machine would hang up on every screened iPhone.
  it("knows the iOS screening event without treating it as a verdict", () => {
    expect([...AMD_SCREENING_EVENTS]).toEqual(["call.machine.premium.call_screening.detected"]);
    expect(isAmdEvent("call.machine.premium.call_screening.detected")).toBe(true);
    expect(AMD_DETECTION_EVENTS.has("call.machine.premium.call_screening.detected")).toBe(false);
    expect(classifyAmdResult("screening")).toBe("unknown");
    expect(greetingImpliesMachine("prompt_ended")).toBe(false);
  });
});

describe("greetingImpliesMachine", () => {
  // Telnyx documents detection.ended as always preceding greeting.ended, so in
  // principle this is redundant. It exists so correctness does not DEPEND on
  // that ordering: a beep is its own proof of a voicemail, and being wrong
  // about the ordering would silently re-introduce the exact bug this module
  // was written to fix.
  it("treats a detected beep as proof of a machine", () => {
    expect(greetingImpliesMachine("beep_detected")).toBe(true);
    expect(greetingImpliesMachine("  BEEP_DETECTED ")).toBe(true);
  });

  // prompt_ended is AMBIGUOUS on its own: it fires both when an iOS screening
  // prompt ends (a live person is deciding) and when an ordinary voicemail
  // greeting ends without a beep. On its own it must therefore prove nothing;
  // classifyGreetingEvent resolves it using whether screening actually
  // announced itself. An earlier version of this file asserted the wrong
  // reason here ("prompt_ended belongs to iOS call screening"), and the
  // handler built on that belief cancelled a correct machine verdict on a
  // live call (Jennifer Kline, 2026-08-17).
  it("never infers a machine from a bare prompt end", () => {
    expect(greetingImpliesMachine("prompt_ended")).toBe(false);
  });

  it.each(["ended", "no_beep_detected", "not_sure", "", "something_new"])(
    "does not infer a machine from %s",
    (result) => {
      expect(greetingImpliesMachine(result)).toBe(false);
    }
  );

  it("tolerates a non-string result", () => {
    expect(greetingImpliesMachine(undefined)).toBe(false);
    expect(greetingImpliesMachine(null)).toBe(false);
    expect(greetingImpliesMachine(7)).toBe(false);
  });
});

/**
 * classifyGreetingEvent: the iOS mode's one genuinely subtle rule.
 *
 * THE INCIDENT (Jennifer Kline, 2026-08-17 16:08Z). Premium AMD correctly
 * returned `machine`. The greeting then ended without a beep, which Telnyx
 * reports as `prompt_ended`, and the handler read that as "Apple call
 * screening, a live person is deciding": it cancelled the correct verdict and
 * returned without hanging up. The assistant pitched into her voicemail for
 * two minutes, and the flow recorded "spoke with them" for a lead who never
 * heard a word.
 *
 * `prompt_ended` means "the prompt finished". WHICH prompt is only knowable
 * from whether call screening ever announced itself.
 */
describe("classifyGreetingEvent", () => {
  const machineOnly = { machineStamped: true, screeningDetected: false };
  const screened = { machineStamped: true, screeningDetected: true };
  const nothingKnown = { machineStamped: false, screeningDetected: false };

  it("prompt_ended after REAL screening means a person is deciding", () => {
    expect(classifyGreetingEvent("prompt_ended", screened)).toBe("screening_person");
  });

  it("prompt_ended with no screening keeps the stamp and waits (Jennifer Kline)", () => {
    // The exact Jennifer case: must NOT return screening_person (that
    // cancelled a correct machine verdict). Must also NOT resolve-and-speak:
    // prompt_ended is the first pause, not the beep, and speaking then is
    // the cancelled_amd hangup. noted = keep the stamp, wait for the beep.
    expect(classifyGreetingEvent("prompt_ended", machineOnly)).toBe("noted");
    expect(classifyGreetingEvent("prompt_ended", machineOnly)).not.toBe("screening_person");
  });

  it("a beep resolves even on a screened call, which rolled to voicemail", () => {
    expect(classifyGreetingEvent("beep_detected", screened)).toBe("machine_resolved");
    expect(classifyGreetingEvent("beep_detected", nothingKnown)).toBe("machine_resolved");
  });

  it("a stamped machine still waits on anything that is not a beep", () => {
    // no_beep_detected arrives at +24 to +26s, inside the iOS screening
    // window. Unknown future Telnyx values fail toward not speaking.
    for (const r of ["no_beep_detected", "ended", "not_sure", "something_new", ""]) {
      expect(classifyGreetingEvent(r, machineOnly), r).toBe("noted");
    }
  });

  it("proves nothing when nothing is known, so a live person is never cut off", () => {
    for (const r of ["prompt_ended", "no_beep_detected", "ended", "", null, undefined, 7]) {
      expect(classifyGreetingEvent(r, nothingKnown), String(r)).toBe("noted");
    }
  });

  it("tolerates casing and whitespace like the rest of the vocabulary", () => {
    expect(classifyGreetingEvent("  PROMPT_ENDED ", screened)).toBe("screening_person");
    expect(classifyGreetingEvent("  PROMPT_ENDED ", nothingKnown)).toBe("noted");
  });
});
