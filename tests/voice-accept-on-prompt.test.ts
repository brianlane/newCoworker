import { describe, expect, it } from "vitest";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { compileVoiceFlow } from "../supabase/functions/_shared/ai_flows/voice";
import { buildHandoffContext } from "../supabase/functions/_shared/voice_handoff";
import type { AiFlowDefinition } from "../supabase/functions/_shared/ai_flows/types";

const voiceFlow = (intake: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "voice", fromE164: "+14159851909" },
  steps: [
    { id: "ring", type: "ring_handoff", toE164: "+16025551234", ringSeconds: 20 },
    { id: "ai", type: "voice_ai_intake", notifyE164: "+16025559999", ...intake }
  ]
});

describe("acceptOnPrompt: authoring", () => {
  it("accepts a digit plus a fallback", () => {
    const def = parseAiFlowDefinition(
      voiceFlow({ answerFirst: true, acceptOnPrompt: { digit: "1", fallbackSeconds: 12 } })
    );
    expect(def.steps).toHaveLength(2);
  });

  it("needs answerFirst: there is no announcement to hear on the takeover path", () => {
    expect(() => parseAiFlowDefinition(voiceFlow({ acceptOnPrompt: { digit: "1" } }))).toThrow(
      AiFlowValidationError
    );
  });

  it("rejects pressing on cue AND on a timer, which would press twice", () => {
    try {
      parseAiFlowDefinition(
        voiceFlow({
          answerFirst: true,
          acceptOnPrompt: { digit: "1" },
          acceptDigits: [{ digit: "1", afterSeconds: 3 }]
        })
      );
      throw new Error("expected the double-owner config to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.join(" ")).toContain("acceptOnPrompt");
    }
    expect(() =>
      parseAiFlowDefinition(
        voiceFlow({ answerFirst: true, acceptOnPrompt: { digit: "1" }, mediaStartSeconds: 2 })
      )
    ).toThrow(AiFlowValidationError);
  });

  it("is exempt from the one-webhook delay budget", () => {
    // The timed path has to fit inside a single Telnyx webhook; pressing on cue
    // happens later, on the bridge's own clock, so a long backstop is fine.
    const def = parseAiFlowDefinition(
      voiceFlow({ answerFirst: true, acceptOnPrompt: { digit: "1", fallbackSeconds: 60 } })
    );
    expect(def.steps).toHaveLength(2);
  });

  it("still enforces a single keypad digit and a sane backstop", () => {
    expect(() =>
      parseAiFlowDefinition(voiceFlow({ answerFirst: true, acceptOnPrompt: { digit: "12" } }))
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition(
        voiceFlow({ answerFirst: true, acceptOnPrompt: { digit: "1", fallbackSeconds: 600 } })
      )
    ).toThrow(AiFlowValidationError);
  });
});

describe("acceptOnPrompt: compiled onto the handoff context", () => {
  const compile = (intake: Record<string, unknown>) => {
    const plan = compileVoiceFlow(
      parseAiFlowDefinition(voiceFlow(intake)) as unknown as AiFlowDefinition,
      "+14805550000"
    );
    if (plan?.kind !== "handoff") throw new Error("expected a handoff plan");
    return plan.context;
  };

  it("carries the gate the bridge reads, with the fallback in ms", () => {
    const ctx = compile({
      answerFirst: true,
      acceptOnPrompt: { digit: "1", fallbackSeconds: 12 }
    });
    expect(ctx.ai_takeover).toMatchObject({
      answer_first: true,
      ivr_gate: { digit: "1", fallback_ms: 12000 }
    });
    // No timed sequence: the answer webhook must press nothing.
    expect(ctx.ai_takeover?.accept_digits).toBeUndefined();
  });

  it("omits the fallback when unset, so the bridge default applies", () => {
    const ctx = compile({ answerFirst: true, acceptOnPrompt: { digit: "9" } });
    expect(ctx.ai_takeover?.ivr_gate).toEqual({ digit: "9" });
  });

  it("leaves the gate absent for a normal timed accept", () => {
    const ctx = compile({ answerFirst: true, acceptDigits: [{ digit: "1", afterSeconds: 3 }] });
    expect(ctx.ai_takeover?.ivr_gate).toBeUndefined();
  });

  it("survives the round trip through the persisted session context", () => {
    // The webhook re-parses what was stored on voice_handoff_sessions, so a
    // gate that does not survive that trip would silently become a blind press.
    const ctx = compile({
      answerFirst: true,
      acceptOnPrompt: { digit: "1", fallbackSeconds: 15 }
    });
    const reparsed = buildHandoffContext({
      steps: ctx.steps,
      aiTakeover: ctx.ai_takeover as unknown as Record<string, unknown>
    });
    expect(reparsed.ai_takeover?.ivr_gate).toEqual({ digit: "1", fallback_ms: 15000 });
  });

  it("drops a malformed gate on the way back in", () => {
    const reparsed = buildHandoffContext({
      steps: [],
      aiTakeover: { notify_e164: "+16025559999", ivr_gate: { digit: "   " } }
    });
    expect(reparsed.ai_takeover?.ivr_gate).toBeUndefined();
  });
});
