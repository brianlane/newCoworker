import { describe, it, expect } from "vitest";
import {
  raiseAcceptFallbackSeconds,
  TARGET_FALLBACK_SECONDS,
  type Definition
} from "../scripts/oneshot/homelight-accept-fallback-20";

function voiceDef(fallbackSeconds?: number): Definition {
  return {
    steps: [
      {
        id: "ai",
        type: "voice_ai_intake",
        answerFirst: true,
        notifyE164: "+16025551212",
        acceptOnPrompt:
          fallbackSeconds === undefined
            ? { digit: "1" }
            : { digit: "1", fallbackSeconds }
      }
    ]
  };
}

describe("raiseAcceptFallbackSeconds", () => {
  it("raises a 12s gate to 20s", () => {
    const def = voiceDef(12);
    expect(raiseAcceptFallbackSeconds(def)).toBe(true);
    expect(
      (def.steps![0].acceptOnPrompt as { fallbackSeconds: number }).fallbackSeconds
    ).toBe(TARGET_FALLBACK_SECONDS);
  });

  it("is a no-op when already at or above the target", () => {
    const at = voiceDef(20);
    expect(raiseAcceptFallbackSeconds(at)).toBe(false);
    const above = voiceDef(25);
    expect(raiseAcceptFallbackSeconds(above)).toBe(false);
  });

  it("treats a missing fallbackSeconds as below target", () => {
    const def = voiceDef();
    expect(raiseAcceptFallbackSeconds(def)).toBe(true);
    expect(
      (def.steps![0].acceptOnPrompt as { fallbackSeconds: number }).fallbackSeconds
    ).toBe(20);
  });

  it("throws when there is no acceptOnPrompt gate", () => {
    expect(() =>
      raiseAcceptFallbackSeconds({
        steps: [{ id: "ai", type: "voice_ai_intake", answerFirst: true }]
      })
    ).toThrow(/acceptOnPrompt/);
  });
});
