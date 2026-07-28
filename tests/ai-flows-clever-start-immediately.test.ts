import { describe, expect, it } from "vitest";
import {
  startImmediately,
  TARGET_FLOW_NAMES,
  type Definition
} from "../scripts/oneshot/clever-start-immediately";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

/** The live "Clever Cue Text": reply Y, then arm the live-transfer window. */
function cueFlow(options?: Record<string, unknown>): Definition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      conditions: [
        { type: "from_matches", value: "3149071456" },
        { type: "contains", value: "LIVE TRANSFER" }
      ]
    },
    steps: [
      { id: "cue", type: "send_sms", to: "{{trigger.from}}", body: "Y" },
      { id: "arm_transfer", type: "arm_voice_transfer", toE164: "+16025551234", windowMinutes: 20 }
    ],
    ...(options ? { options } : {})
  };
}

describe("clever-start-immediately", () => {
  it("targets exactly the two time-critical flows", () => {
    // The other Clever flows are internal notifications or bulk portal updates,
    // where a kick per message is cost without benefit.
    expect(TARGET_FLOW_NAMES).toEqual(["Clever Cue Text", "Clever Lead - Accept"]);
  });

  it("turns the option on and leaves a valid definition", () => {
    const def = cueFlow();
    expect(startImmediately(def)).toBe(true);
    expect(def.options?.startImmediately).toBe(true);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("keeps the options already there", () => {
    const def = cueFlow({ suppressDefaultReply: true });
    startImmediately(def);
    expect(def.options).toEqual({ suppressDefaultReply: true, startImmediately: true });
  });

  it("leaves the steps and trigger untouched", () => {
    // It is a timing change only: the cue text and the arm window must not move.
    const def = cueFlow();
    const before = JSON.stringify({ steps: def.steps, trigger: def.trigger });
    startImmediately(def);
    expect(JSON.stringify({ steps: def.steps, trigger: def.trigger })).toBe(before);
  });

  it("is idempotent", () => {
    const def = cueFlow();
    expect(startImmediately(def)).toBe(true);
    expect(startImmediately(def)).toBe(false);
  });

  it("refuses a flow no webhook can kick", () => {
    expect(() =>
      startImmediately({ version: 1, trigger: { channel: "voice" }, steps: [] } as Definition)
    ).toThrow(/only an sms-triggered flow/);
    expect(() => startImmediately({ version: 1, steps: [] } as Definition)).toThrow(
      /only an sms-triggered flow/
    );
  });
});
