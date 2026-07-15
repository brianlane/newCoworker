import { describe, expect, it } from "vitest";
import {
  encodeOutboundClientState,
  outboundSessionContext,
  parseOutboundClientState,
  parsePlaceCallPayload,
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

describe("outboundSessionContext", () => {
  it("includes persona + capture_fields when present", () => {
    const ctx = outboundSessionContext({
      toE164: "+19178628675",
      notifyE164: "+16026951142",
      persona: "Amy's assistant",
      captureFields: ["name", "timeline"]
    });
    expect(ctx).toEqual({
      outbound: true,
      ai_takeover: {
        notify_e164: "+16026951142",
        persona: "Amy's assistant",
        capture_fields: ["name", "timeline"]
      }
    });
  });

  it("omits persona + capture_fields when null/empty (bridge uses defaults)", () => {
    const ctx = outboundSessionContext({
      toE164: "",
      notifyE164: "+16026951142",
      persona: null,
      captureFields: null
    });
    expect(ctx).toEqual({ outbound: true, ai_takeover: { notify_e164: "+16026951142" } });
    expect(ctx.ai_takeover).not.toHaveProperty("persona");
    expect(ctx.ai_takeover).not.toHaveProperty("capture_fields");
  });

  it("omits capture_fields for an empty array", () => {
    const ctx = outboundSessionContext({
      toE164: "",
      notifyE164: "+16026951142",
      persona: null,
      captureFields: []
    });
    expect(ctx.ai_takeover).not.toHaveProperty("capture_fields");
  });

  it("carries a place_ai_call transfer config + parked-run link into the session", () => {
    const ctx = outboundSessionContext({
      toE164: "+19178628675",
      notifyE164: "+16026951142",
      persona: "Amy's assistant",
      contextNote: "Their name: Bryan.",
      captureFields: null,
      transfer: {
        toE164: "+16025245719",
        preSmsBody: "LIVE TRANSFER incoming — pick up!",
        agentName: "Dave Lane"
      },
      flowRun: { runId: "run-1", saveAs: "call_outcome", marker: "__called_c1", stepIndex: 4 }
    });
    expect(ctx.ai_takeover.context_note).toBe("Their name: Bryan.");
    expect(ctx.transfer).toEqual({
      to_e164: "+16025245719",
      pre_sms_body: "LIVE TRANSFER incoming — pick up!",
      agent_name: "Dave Lane"
    });
    expect(ctx.flow_run).toEqual({
      run_id: "run-1",
      save_as: "call_outcome",
      marker: "__called_c1",
      step_index: 4
    });
  });

  it("a bare transfer target omits the optional pre-alert/name keys", () => {
    const ctx = outboundSessionContext({
      toE164: "+19178628675",
      notifyE164: "+16026951142",
      persona: null,
      captureFields: null,
      transfer: { toE164: "+16025245719" }
    });
    expect(ctx.transfer).toEqual({ to_e164: "+16025245719" });
    expect(ctx).not.toHaveProperty("flow_run");
  });
});

describe("parsePlaceCallPayload", () => {
  const BASE = { toE164: "+17572390150", notifyE164: "+16026951142" };

  it("parses a full payload", () => {
    const plan = parsePlaceCallPayload({
      ...BASE,
      persona: "Hi, Amy's office!",
      contextNote: "Their name: Bryan.",
      captureFields: ["best time", " ", 7],
      transfer: {
        toE164: "+16025245719",
        preSmsBody: "pick up!",
        agentName: "Dave Lane"
      },
      flowRun: { runId: "run-1", saveAs: "call_outcome", marker: "__called_c1", stepIndex: 4 }
    });
    expect(plan).toEqual({
      toE164: "+17572390150",
      notifyE164: "+16026951142",
      persona: "Hi, Amy's office!",
      contextNote: "Their name: Bryan.",
      captureFields: ["best time"],
      transfer: { toE164: "+16025245719", preSmsBody: "pick up!", agentName: "Dave Lane" },
      flowRun: { runId: "run-1", saveAs: "call_outcome", marker: "__called_c1", stepIndex: 4 }
    });
  });

  it("drops a blank contextNote", () => {
    expect(parsePlaceCallPayload({ ...BASE, contextNote: "  " })).not.toHaveProperty(
      "contextNote"
    );
  });

  it("parses a minimal payload (no persona/captureFields/transfer/flowRun)", () => {
    expect(parsePlaceCallPayload(BASE)).toEqual({
      toE164: "+17572390150",
      notifyE164: "+16026951142",
      persona: null,
      captureFields: null
    });
  });

  it("drops a capture list that filters to empty and a transfer with only a target", () => {
    const plan = parsePlaceCallPayload({
      ...BASE,
      captureFields: ["  "],
      transfer: { toE164: "+16025245719", preSmsBody: "  ", agentName: "" }
    });
    expect(plan?.captureFields).toBeNull();
    expect(plan?.transfer).toEqual({ toE164: "+16025245719" });
  });

  it("rejects non-objects and missing callee/notify", () => {
    expect(parsePlaceCallPayload(null)).toBeNull();
    expect(parsePlaceCallPayload("x")).toBeNull();
    expect(parsePlaceCallPayload({ notifyE164: "+16026951142" })).toBeNull();
    expect(parsePlaceCallPayload({ toE164: "+17572390150" })).toBeNull();
  });

  it("rejects a transfer without a target (half-read configs must not dial)", () => {
    expect(parsePlaceCallPayload({ ...BASE, transfer: {} })).toBeNull();
    expect(parsePlaceCallPayload({ ...BASE, transfer: null })).toBeNull();
  });

  it("rejects a malformed flowRun link", () => {
    for (const flowRun of [
      null,
      {},
      { runId: "run-1", saveAs: "v", marker: "m" }, // no stepIndex
      { runId: "run-1", saveAs: "v", marker: "m", stepIndex: -1 },
      { runId: "run-1", saveAs: "v", marker: "m", stepIndex: 1.5 },
      { runId: "", saveAs: "v", marker: "m", stepIndex: 0 }
    ]) {
      expect(parsePlaceCallPayload({ ...BASE, flowRun })).toBeNull();
    }
  });
});
