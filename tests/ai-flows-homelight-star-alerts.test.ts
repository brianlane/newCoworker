import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { setStarAlerts } from "../scripts/oneshot/set-homelight-star-alerts";

/** Amy's live HomeLight chain: ring Dave, ring Amy, then the AI intake. */
function homelightFlow(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "voice", fromE164: "+14159851909" },
    steps: [
      { id: "ring1", type: "ring_handoff", toE164: "+16025245719", ringSeconds: 20 },
      { id: "ring2", type: "ring_handoff", toE164: "+16026951142", ringSeconds: 20 },
      {
        id: "ai3",
        type: "voice_ai_intake",
        notifyE164: "+16026951142",
        persona: "Hi, this is the office.",
        captureFields: ["name", "phone", "address", "timeframe", "notes"]
      }
    ],
    options: { suppressDefaultReply: false, captureStepScreenshots: false }
  };
}

describe("setStarAlerts", () => {
  it("turns the option on and leaves the rest of the flow untouched", () => {
    const def = homelightFlow();
    const before = JSON.stringify({ ...def, options: undefined });
    expect(setStarAlerts(def, true)).toBe(true);
    expect(def.options).toEqual({
      suppressDefaultReply: false,
      captureStepScreenshots: false,
      starAlerts: true
    });
    // Steps and trigger are byte-identical: no new sends, no new timing.
    expect(JSON.stringify({ ...def, options: undefined })).toBe(before);
  });

  it("is idempotent (a second run reports no change)", () => {
    const def = homelightFlow();
    expect(setStarAlerts(def, true)).toBe(true);
    expect(setStarAlerts(def, true)).toBe(false);
  });

  it("clears by DELETING the key, not storing false", () => {
    const def = homelightFlow();
    setStarAlerts(def, true);
    expect(setStarAlerts(def, false)).toBe(true);
    expect(Object.keys(def.options as object)).not.toContain("starAlerts");
    // Already off is a no-op, including when the flow has no options at all.
    expect(setStarAlerts(def, false)).toBe(false);
    const bare: Record<string, unknown> = { version: 1 };
    expect(setStarAlerts(bare, false)).toBe(false);
  });

  it("creates the options object when the flow has none", () => {
    const def: Record<string, unknown> = { version: 1, steps: [] };
    expect(setStarAlerts(def, true)).toBe(true);
    expect(def.options).toEqual({ starAlerts: true });
  });

  it("leaves the patched HomeLight flow valid under the authoring schema", () => {
    const def = homelightFlow();
    setStarAlerts(def, true);
    const parsed = parseAiFlowDefinition(def);
    expect(parsed.options?.starAlerts).toBe(true);
    expect(parsed.steps).toHaveLength(3);
  });
});
