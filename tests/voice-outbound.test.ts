import { describe, expect, it } from "vitest";
import {
  encodeOutboundClientState,
  parseOutboundClientState,
  resolveOutboundCallPlan
} from "../supabase/functions/_shared/voice_outbound";
import { parseHandoffClientState } from "../supabase/functions/_shared/voice_handoff";
import type { AiFlowDefinition } from "../supabase/functions/_shared/ai_flows/types";

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SESS = "11111111-2222-3333-4444-555555555555";

function outboundDef(
  step: Partial<Extract<AiFlowDefinition["steps"][number], { type: "outbound_call" }>> = {}
): AiFlowDefinition {
  return {
    version: 1,
    trigger: { channel: "voice", direction: "outbound" },
    steps: [{ id: "c", type: "outbound_call", notifyE164: "+16026951142", ...step }]
  } as AiFlowDefinition;
}

describe("outbound client_state", () => {
  it("round-trips plain text", () => {
    const cs = encodeOutboundClientState(BIZ, SESS);
    expect(cs).toBe(`vob:${BIZ}:${SESS}`);
    expect(parseOutboundClientState(cs)).toEqual({ businessId: BIZ, sessionId: SESS });
  });

  it("decodes a base64-encoded state (how Telnyx echoes it)", () => {
    const cs = encodeOutboundClientState(BIZ, SESS);
    const b64 = btoa(cs);
    expect(parseOutboundClientState(b64)).toEqual({ businessId: BIZ, sessionId: SESS });
  });

  it("returns null for empty / non-outbound / malformed states", () => {
    expect(parseOutboundClientState(undefined)).toBeNull();
    expect(parseOutboundClientState("")).toBeNull();
    expect(parseOutboundClientState("hl:abc:0")).toBeNull();
    expect(parseOutboundClientState("vob:onlyone")).toBeNull();
    expect(parseOutboundClientState("vob::")).toBeNull();
  });

  it("a handoff parser ignores an outbound state and vice versa", () => {
    const vob = encodeOutboundClientState(BIZ, SESS);
    // Critical for settlement parity: call-end must NOT treat an outbound leg as
    // a handoff leg (that would short-circuit before settlement).
    expect(parseHandoffClientState(vob)).toBeNull();
    expect(parseHandoffClientState(btoa(vob))).toBeNull();
    expect(parseOutboundClientState("hl:abc:0")).toBeNull();
  });
});

describe("resolveOutboundCallPlan", () => {
  it("reads the outbound_call step config", () => {
    const plan = resolveOutboundCallPlan(
      outboundDef({
        toE164: "+19178628675",
        persona: "Amy's assistant",
        captureFields: ["name", "timeline"]
      })
    );
    expect(plan).toEqual({
      toE164: "+19178628675",
      notifyE164: "+16026951142",
      persona: "Amy's assistant",
      captureFields: ["name", "timeline"]
    });
  });

  it("defaults optional fields and a missing toE164 to null/empty", () => {
    const plan = resolveOutboundCallPlan(outboundDef());
    expect(plan).toEqual({
      toE164: "",
      notifyE164: "+16026951142",
      persona: null,
      captureFields: null
    });
  });

  it("returns null when notifyE164 is blank", () => {
    expect(resolveOutboundCallPlan(outboundDef({ notifyE164: "  " }))).toBeNull();
  });

  it("returns null when notifyE164 is not a string (defensive)", () => {
    expect(resolveOutboundCallPlan(outboundDef({ notifyE164: 16026951142 as never }))).toBeNull();
  });

  it("returns null for an inbound voice flow", () => {
    const inbound = {
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [{ id: "r", type: "ring_handoff", toE164: "+16025245719" }]
    } as AiFlowDefinition;
    expect(resolveOutboundCallPlan(inbound)).toBeNull();
  });

  it("returns null for a non-voice flow", () => {
    const sms = {
      version: 1,
      trigger: { channel: "sms", correlationWindowMinutes: 10, conditions: [] },
      steps: []
    } as unknown as AiFlowDefinition;
    expect(resolveOutboundCallPlan(sms)).toBeNull();
  });

  it("treats a non-array steps payload as empty (returns null)", () => {
    const malformed = {
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: undefined
    } as unknown as AiFlowDefinition;
    expect(resolveOutboundCallPlan(malformed)).toBeNull();
  });
});
