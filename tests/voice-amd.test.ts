import { describe, expect, it } from "vitest";
import {
  AMD_DETECTION_EVENTS,
  AMD_GREETING_EVENTS,
  AMD_SCREENING_EVENTS,
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

  // prompt_ended belongs to iOS call screening, where a live PERSON is
  // deciding whether to take the call. Treating it as a machine would hang up
  // on them.
  it("never infers a machine from an iOS screening prompt", () => {
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
