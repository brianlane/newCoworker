import { describe, it, expect } from "vitest";
import {
  buildHandoffContext,
  encodeHandoffClientState,
  parseHandoffClientState,
  planHandoffAdvance,
  type HandoffStep
} from "../supabase/functions/_shared/voice_handoff";

const STEPS: HandoffStep[] = [
  { to_e164: "+16025245719", ring_secs: 20 },
  { to_e164: "+16026951142", ring_secs: 20 }
];

describe("voice_handoff client_state", () => {
  it("round-trips encode -> parse with a plain string", () => {
    const cs = encodeHandoffClientState("cc-abc", 1);
    expect(cs).toBe("hl:cc-abc:1");
    expect(parseHandoffClientState(cs)).toEqual({ aLegCallId: "cc-abc", step: 1 });
  });

  it("parses a base64-encoded client_state (as Telnyx echoes it)", () => {
    const plain = encodeHandoffClientState("cc-xyz", 0);
    const b64 = Buffer.from(plain, "utf8").toString("base64");
    expect(parseHandoffClientState(b64)).toEqual({ aLegCallId: "cc-xyz", step: 0 });
  });

  it("handles a call id containing colons", () => {
    const cs = encodeHandoffClientState("v3:call:id:99", 2);
    expect(parseHandoffClientState(cs)).toEqual({ aLegCallId: "v3:call:id:99", step: 2 });
  });

  it("returns null for missing / non-handoff / malformed client_state", () => {
    expect(parseHandoffClientState(undefined)).toBeNull();
    expect(parseHandoffClientState("")).toBeNull();
    expect(parseHandoffClientState("not-base64-and-not-hl")).toBeNull();
    expect(parseHandoffClientState("hl:cc:notanumber")).toBeNull();
  });
});

describe("planHandoffAdvance", () => {
  it("rings the next human step when one remains", () => {
    expect(
      planHandoffAdvance({ steps: STEPS, failedStep: 0, hasAiTakeover: true })
    ).toEqual({ kind: "transfer", step: 1, toE164: "+16026951142", ringSecs: 20 });
  });

  it("hands to AI takeover after the last human step when configured", () => {
    expect(
      planHandoffAdvance({ steps: STEPS, failedStep: 1, hasAiTakeover: true })
    ).toEqual({ kind: "ai_takeover" });
  });

  it("hangs up after the last human step when no AI takeover is configured", () => {
    expect(
      planHandoffAdvance({ steps: STEPS, failedStep: 1, hasAiTakeover: false })
    ).toEqual({ kind: "hangup" });
  });

  it("defaults a missing/invalid ring_secs to 20", () => {
    const steps = [
      { to_e164: "+1aaa", ring_secs: 20 },
      { to_e164: "+1bbb", ring_secs: 0 }
    ] as HandoffStep[];
    expect(planHandoffAdvance({ steps, failedStep: 0, hasAiTakeover: false })).toEqual({
      kind: "transfer",
      step: 1,
      toE164: "+1bbb",
      ringSecs: 20
    });
  });
});

describe("buildHandoffContext", () => {
  it("normalizes steps (drops empty, defaults ring, skips null elements) and ai_takeover", () => {
    const ctx = buildHandoffContext({
      toE164: "+14805551212",
      steps: [
        { to_e164: "+16025245719", ring_secs: 20 }, // kept as-is
        null, // null element -> {} -> dropped
        { to_e164: "+16026951142" }, // ring_secs defaulted to 20
        { ring_secs: 30 } // no to_e164 -> dropped
      ],
      aiTakeover: { notify_e164: "+16026951142", persona: "Hi", capture_fields: ["name", 5] }
    });
    expect(ctx.to_e164).toBe("+14805551212");
    expect(ctx.steps).toEqual([
      { to_e164: "+16025245719", ring_secs: 20 },
      { to_e164: "+16026951142", ring_secs: 20 }
    ]);
    expect(ctx.ai_takeover).toEqual({
      notify_e164: "+16026951142",
      persona: "Hi",
      capture_fields: ["name"] // non-string entries filtered out
    });
  });

  it("yields [] steps for a non-array, and null ai_takeover when notify_e164 is missing", () => {
    const ctx = buildHandoffContext({ toE164: "+1x", steps: null, aiTakeover: { persona: "x" } });
    expect(ctx.steps).toEqual([]);
    expect(ctx.ai_takeover).toBeNull();
  });

  it("yields null ai_takeover when ai_takeover is not an object", () => {
    const ctx = buildHandoffContext({ toE164: "+1y", steps: [], aiTakeover: null });
    expect(ctx.ai_takeover).toBeNull();
  });

  it("defaults persona/capture_fields to undefined when they are not the expected types", () => {
    const ctx = buildHandoffContext({
      toE164: "+1z",
      steps: [],
      aiTakeover: { notify_e164: "+15551234567", persona: 5, capture_fields: "nope" }
    });
    expect(ctx.ai_takeover).toEqual({
      notify_e164: "+15551234567",
      persona: undefined,
      capture_fields: undefined
    });
  });
});
