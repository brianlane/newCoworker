import { describe, expect, it } from "vitest";
import {
  switchToAcceptOnPrompt,
  type Definition
} from "../scripts/oneshot/homelight-accept-on-prompt";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

/** Amy's live voice flow: two rings as the fallback, then the AI-first intake. */
function voiceDef(intake: Record<string, unknown> = {}): Definition {
  return {
    version: 1,
    trigger: { channel: "voice", fromE164: "+14159851909" },
    steps: [
      { id: "ring1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 },
      { id: "ring2", type: "ring_handoff", toE164: "+16026951142", ringSeconds: 20 },
      {
        id: "ai",
        type: "voice_ai_intake",
        notifyE164: "+16025245719",
        alsoNotifyE164: "+16026951142",
        persona: "Hi, this is Amy Laidlaw's office with HomeSmart.",
        captureFields: ["name", "phone", "address", "timeframe", "notes"],
        answerFirst: true,
        acceptDigits: [{ digit: "1", afterSeconds: 3 }],
        mediaStartSeconds: 2,
        briefFromSmsContaining: "HomeLight Referral",
        ...intake
      }
    ]
  };
}

const intakeOf = (def: Definition) => (def.steps ?? []).find((s) => s.type === "voice_ai_intake")!;

describe("homelight-accept-on-prompt", () => {
  it("replaces the guessed 3-second press with one on the prompt", () => {
    const def = voiceDef();
    expect(switchToAcceptOnPrompt(def, { digit: "1", fallbackSeconds: 12 })).toBe(true);
    expect(intakeOf(def).acceptOnPrompt).toEqual({ digit: "1", fallbackSeconds: 12 });
  });

  it("removes the timed sequence, which would otherwise press twice", () => {
    // The webhook and the bridge would each own the same keypress, and the
    // second tone would land on whatever the menu moved on to. The schema
    // rejects the combination outright, so leaving them would fail authoring.
    const def = voiceDef();
    switchToAcceptOnPrompt(def, { digit: "1", fallbackSeconds: 12 });
    expect(intakeOf(def).acceptDigits).toBeUndefined();
    expect(intakeOf(def).mediaStartSeconds).toBeUndefined();
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("leaves everything else about the intake alone", () => {
    const def = voiceDef();
    switchToAcceptOnPrompt(def, { digit: "1", fallbackSeconds: 12 });
    expect(intakeOf(def)).toMatchObject({
      answerFirst: true,
      notifyE164: "+16025245719",
      alsoNotifyE164: "+16026951142",
      briefFromSmsContaining: "HomeLight Referral",
      captureFields: ["name", "phone", "address", "timeframe", "notes"]
    });
    // The human fallback chain is untouched: if the bridge cannot attach, the
    // rings are what get the referral accepted by a person's own keypad.
    expect((def.steps ?? []).filter((s) => s.type === "ring_handoff")).toHaveLength(2);
  });

  it("is idempotent", () => {
    const def = voiceDef();
    expect(switchToAcceptOnPrompt(def, { digit: "1", fallbackSeconds: 12 })).toBe(true);
    expect(switchToAcceptOnPrompt(def, { digit: "1", fallbackSeconds: 12 })).toBe(false);
  });

  it("honours a different digit and backstop", () => {
    const def = voiceDef();
    switchToAcceptOnPrompt(def, { digit: "9", fallbackSeconds: 20 });
    expect(intakeOf(def).acceptOnPrompt).toEqual({ digit: "9", fallbackSeconds: 20 });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("fails loudly on a flow it cannot patch", () => {
    const noIntake: Definition = {
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [{ id: "ring1", type: "ring_handoff", toE164: "+16025245719" }]
    };
    expect(() => switchToAcceptOnPrompt(noIntake, { digit: "1", fallbackSeconds: 12 })).toThrow(
      /voice_ai_intake/
    );
    // A takeover-only intake has no announcement to hear: a human already
    // accepted the referral before the AI ever picks up.
    const takeover = voiceDef({ answerFirst: undefined, acceptDigits: undefined });
    expect(() => switchToAcceptOnPrompt(takeover, { digit: "1", fallbackSeconds: 12 })).toThrow(
      /answerFirst/
    );
  });
});
