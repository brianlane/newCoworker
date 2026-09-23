import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  BAFITNESS_BOOKING_URL,
  BAFITNESS_CALL_DELAY_MINUTES,
  BAFITNESS_CLINIC_SOURCE,
  buildBafitnessClinicSheetDefinition
} from "../scripts/oneshot/bafitness-clinic-sheet-definition";

describe("BA Fitness clinic sheet call", () => {
  const def = buildBafitnessClinicSheetDefinition();

  it("parses, waits 7 minutes, and only starts from the sheet source", () => {
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.trigger).toMatchObject({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: BAFITNESS_CLINIC_SOURCE, caseInsensitive: true }]
    });
    expect(def.steps[1]).toMatchObject({ type: "sleep", minutes: BAFITNESS_CALL_DELAY_MINUTES });
    expect(BAFITNESS_CALL_DELAY_MINUTES).toBe(7);
  });

  it("calls Dane on Pacific time and everyone else on Eastern, and does not create a contact", () => {
    const branch = def.steps[2];
    expect(branch.type).toBe("branch");
    if (branch.type !== "branch") return;
    const dane = branch.branches[0].steps[0];
    const eastern = branch.else[0];
    expect(dane).toMatchObject({
      type: "place_ai_call",
      callWindow: { timezone: "America/Los_Angeles", start: "09:00", end: "18:00", outside: "defer" }
    });
    expect(eastern).toMatchObject({
      type: "place_ai_call",
      callWindow: { timezone: "America/New_York", outside: "defer" }
    });
    expect(JSON.stringify(def)).not.toContain("upsert_customer");
    expect(JSON.stringify(def)).toContain(BAFITNESS_BOOKING_URL);
    expect(JSON.stringify(def)).toContain("Quinn");
    expect(JSON.stringify(def)).not.toContain("\u2014");
    expect(JSON.stringify(def).toLowerCase()).not.toContain("enquiry");
  });
});
