import { describe, expect, it } from "vitest";
import { compileVoiceFlow } from "../supabase/functions/_shared/ai_flows/voice";
import type { AiFlowDefinition } from "../supabase/functions/_shared/ai_flows/types";

const TO = "+16025550100"; // the business number that was dialed

function def(steps: AiFlowDefinition["steps"], fromE164 = "+14159851909"): AiFlowDefinition {
  return { version: 1, trigger: { channel: "voice", fromE164 }, steps };
}

describe("compileVoiceFlow", () => {
  it("compiles a single voice_transfer into a blind-transfer plan", () => {
    const plan = compileVoiceFlow(
      def([{ id: "t", type: "voice_transfer", toE164: "+16026951142", whisper: "Connecting you now." }]),
      TO
    );
    expect(plan).toEqual({ kind: "transfer", toE164: "+16026951142", whisper: "Connecting you now." });
  });

  it("defaults whisper to an empty string when absent", () => {
    const plan = compileVoiceFlow(
      def([{ id: "t", type: "voice_transfer", toE164: "+16026951142" }]),
      TO
    );
    expect(plan).toEqual({ kind: "transfer", toE164: "+16026951142", whisper: "" });
  });

  it("compiles ring_handoff steps + voice_ai_intake into a handoff context", () => {
    const plan = compileVoiceFlow(
      def([
        { id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 25 },
        { id: "r2", type: "ring_handoff", toE164: "+16026951142" },
        {
          id: "ai",
          type: "voice_ai_intake",
          notifyE164: "+16026951142",
          persona: "Amy's assistant",
          captureFields: ["name", "phone"]
        }
      ]),
      TO
    );
    expect(plan?.kind).toBe("handoff");
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.to_e164).toBe(TO);
    expect(plan.context.steps).toEqual([
      { to_e164: "+16025245719", ring_secs: 25 },
      // missing ringSeconds defaults to 20 (coerceRingSecs)
      { to_e164: "+16026951142", ring_secs: 20 }
    ]);
    expect(plan.context.ai_takeover).toEqual({
      notify_e164: "+16026951142",
      persona: "Amy's assistant",
      capture_fields: ["name", "phone"]
    });
  });

  it("compiles a ring-only chain with no AI takeover", () => {
    const plan = compileVoiceFlow(
      def([{ id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 }]),
      TO
    );
    expect(plan?.kind).toBe("handoff");
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.ai_takeover).toBeNull();
    expect(plan.context.steps).toHaveLength(1);
  });

  it("returns null for a non-voice channel", () => {
    const notVoice = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: []
    } as unknown as AiFlowDefinition;
    expect(compileVoiceFlow(notVoice, TO)).toBeNull();
  });

  it("returns null when a handoff chain has no ringable human", () => {
    // An intake-only flow can't start (no human to ring) — falls through.
    const plan = compileVoiceFlow(
      def([{ id: "ai", type: "voice_ai_intake", notifyE164: "+16026951142" }]),
      TO
    );
    expect(plan).toBeNull();
  });

  it("returns null when voice_transfer has no destination", () => {
    const plan = compileVoiceFlow(
      def([{ id: "t", type: "voice_transfer", toE164: "" } as never]),
      TO
    );
    expect(plan).toBeNull();
  });

  it("returns null when voice_transfer destination is not a string", () => {
    const plan = compileVoiceFlow(
      def([{ id: "t", type: "voice_transfer", toE164: 16026951142 } as never]),
      TO
    );
    expect(plan).toBeNull();
  });

  it("treats a non-array steps payload as empty (returns null)", () => {
    const malformed = {
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: undefined
    } as unknown as AiFlowDefinition;
    expect(compileVoiceFlow(malformed, TO)).toBeNull();
  });

  it("drops ring steps with a blank destination", () => {
    const plan = compileVoiceFlow(
      def([
        { id: "r0", type: "ring_handoff", toE164: "" } as never,
        { id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 }
      ]),
      TO
    );
    expect(plan?.kind).toBe("handoff");
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.steps).toEqual([{ to_e164: "+16025245719", ring_secs: 20 }]);
  });
});
