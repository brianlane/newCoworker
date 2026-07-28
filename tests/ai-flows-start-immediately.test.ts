import { describe, expect, it } from "vitest";
import {
  startImmediately,
  type Definition
} from "../scripts/oneshot/homelight-start-immediately";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";

function smsFlow(options?: Record<string, unknown>): Definition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      conditions: [
        { type: "has_url" },
        { type: "regex", value: "New HomeLight (Referral|Warm Transfer)", caseInsensitive: true }
      ],
      correlationWindowMinutes: 15
    },
    steps: [{ id: "url", type: "extract_url", saveAs: "leadUrl" }],
    ...(options ? { options } : {})
  };
}

describe("options.startImmediately: authoring", () => {
  it("is accepted by the schema and needs no other change", () => {
    const def = parseAiFlowDefinition(smsFlow({ startImmediately: true }));
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(def.options?.startImmediately).toBe(true);
  });

  it("defaults to absent, so no existing flow starts paying for a kick", () => {
    const def = parseAiFlowDefinition(smsFlow());
    expect(def.options?.startImmediately).toBeUndefined();
  });
});

describe("homelight-start-immediately one-shot", () => {
  it("turns the option on", () => {
    const def = smsFlow();
    expect(startImmediately(def)).toBe(true);
    expect(def.options?.startImmediately).toBe(true);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("keeps the options already there", () => {
    // The flow carries suppressDefaultReply and friends; losing them would
    // change behaviour well beyond timing.
    const def = smsFlow({ suppressDefaultReply: true, allowReentry: true });
    startImmediately(def);
    expect(def.options).toEqual({
      suppressDefaultReply: true,
      allowReentry: true,
      startImmediately: true
    });
  });

  it("is idempotent", () => {
    const def = smsFlow();
    expect(startImmediately(def)).toBe(true);
    expect(startImmediately(def)).toBe(false);
  });

  it("refuses a flow no webhook can kick", () => {
    // Only the inbound-SMS path kicks the worker; on a voice or scheduled flow
    // the setting would look enabled and do nothing.
    const voice: Definition = {
      version: 1,
      trigger: { channel: "voice" },
      steps: []
    };
    expect(() => startImmediately(voice)).toThrow(/only an sms-triggered flow/);
    expect(() => startImmediately({ version: 1, steps: [] } as Definition)).toThrow(
      /only an sms-triggered flow/
    );
  });
});
