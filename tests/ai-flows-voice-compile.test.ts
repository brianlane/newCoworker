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
    // An intake-only flow can't start (no human to ring), falls through.
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

  it("returns null for an outbound voice flow (placed, not matched on inbound)", () => {
    const outbound = {
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [{ id: "c", type: "outbound_call", notifyE164: "+16026951142" }]
    } as unknown as AiFlowDefinition;
    expect(compileVoiceFlow(outbound, TO)).toBeNull();
  });

  it("compiles an AI-first intake onto the takeover context", () => {
    const plan = compileVoiceFlow(
      def([
        { id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 },
        {
          id: "ai",
          type: "voice_ai_intake",
          notifyE164: "+16025245719",
          alsoNotifyE164: "+16026951142",
          answerFirst: true,
          acceptDigits: [{ digit: "1", afterSeconds: 3 }],
          mediaStartSeconds: 2,
          briefFromSmsContaining: "HomeLight Referral"
        }
      ]),
      TO
    );
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.ai_takeover).toEqual({
      notify_e164: "+16025245719",
      persona: undefined,
      capture_fields: undefined,
      also_notify_e164: "+16026951142",
      answer_first: true,
      accept_digits: [{ digit: "1", after_seconds: 3 }],
      media_start_seconds: 2,
      brief_sms_contains: "HomeLight Referral"
    });
    // The ring steps survive as the fallback the AI-first path needs.
    expect(plan.context.steps).toEqual([{ to_e164: "+16025245719", ring_secs: 20 }]);
  });

  it("leaves an ordinary intake's takeover context unchanged", () => {
    const plan = compileVoiceFlow(
      def([
        { id: "r1", type: "ring_handoff", toE164: "+16025245719" },
        { id: "ai", type: "voice_ai_intake", notifyE164: "+16026951142", persona: "Hi" }
      ]),
      TO
    );
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.ai_takeover).toEqual({
      notify_e164: "+16026951142",
      persona: "Hi",
      capture_fields: undefined
    });
  });

  it("leaves an unauthored digit wait absent instead of collapsing it to zero", () => {
    // 0 would press into an announcement that is still playing, which the
    // partner's IVR does not accept at all; absent means "use the default".
    const plan = compileVoiceFlow(
      def([
        { id: "r1", type: "ring_handoff", toE164: "+16025245719" },
        {
          id: "ai",
          type: "voice_ai_intake",
          notifyE164: "+16026951142",
          answerFirst: true,
          acceptDigits: [{ digit: "1" }, { digit: "2", afterSeconds: 0 }]
        }
      ]),
      TO
    );
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.ai_takeover?.accept_digits).toEqual([
      { digit: "1" },
      { digit: "2", after_seconds: 0 }
    ]);
  });

  it("carries options.starAlerts onto the handoff context", () => {
    // The flag rides the session row so telnyx-voice-call-end and the voice
    // bridge can frame their texts without re-reading the flow mid-call.
    const withStars: AiFlowDefinition = {
      ...def([{ id: "r1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 }]),
      options: { starAlerts: true }
    };
    const plan = compileVoiceFlow(withStars, TO);
    if (plan?.kind !== "handoff") throw new Error("expected handoff");
    expect(plan.context.star_alerts).toBe(true);
  });

  it("omits star_alerts entirely when the flow did not opt in", () => {
    // Absent (not false) keeps an opted-out chain's persisted context
    // byte-identical to what it was before star alerts existed.
    for (const options of [undefined, { starAlerts: false }, { suppressDefaultReply: true }]) {
      const plan = compileVoiceFlow(
        {
          ...def([{ id: "r1", type: "ring_handoff", toE164: "+16025245719" }]),
          ...(options ? { options } : {})
        },
        TO
      );
      if (plan?.kind !== "handoff") throw new Error("expected handoff");
      expect(Object.keys(plan.context)).not.toContain("star_alerts");
    }
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
