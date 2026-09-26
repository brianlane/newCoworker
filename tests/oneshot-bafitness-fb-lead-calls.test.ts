import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateTriggerConditions } from "@/lib/ai-flows/trigger-eval";
import { BRANCH_ELSE_ARM, chooseBranchArm } from "../supabase/functions/_shared/ai_flows/branching";
import {
  BAFITNESS_BOOKING_URL,
  BAFITNESS_FB_CALL_DELAY_MINUTES,
  BAFITNESS_FB_SOURCE,
  buildBafitnessFbLeadCallsDefinition
} from "../scripts/oneshot/bafitness-fb-lead-calls-definition";

describe("BA Fitness FB Patient + Clinic Quinn call", () => {
  const def = buildBafitnessFbLeadCallsDefinition();

  it("parses, waits 7 minutes, and only starts from facebook_lead_ads", () => {
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.trigger).toMatchObject({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: BAFITNESS_FB_SOURCE, caseInsensitive: true }]
    });
    expect(def.steps[1]).toMatchObject({ type: "sleep", minutes: BAFITNESS_FB_CALL_DELAY_MINUTES });
    expect(BAFITNESS_FB_CALL_DELAY_MINUTES).toBe(7);
  });

  it("matches facebook_lead_ads and does not match clinic_google_sheet", () => {
    const conditions = def.trigger && "conditions" in def.trigger ? def.trigger.conditions : [];
    expect(
      evaluateTriggerConditions(conditions, "clinic_type: Wellness clinic", "facebook_lead_ads")
    ).toBe(true);
    expect(
      evaluateTriggerConditions(conditions, "biggest_challenge: Exercise", "facebook_lead_ads")
    ).toBe(true);
    expect(
      evaluateTriggerConditions(conditions, "clinic_type: Wellness clinic", "clinic_google_sheet")
    ).toBe(false);
    expect(evaluateTriggerConditions(conditions, "name: Test", "webhook")).toBe(false);
  });

  it("does not create a contact, uses Quinn, and has no em dash", () => {
    const raw = JSON.stringify(def);
    expect(raw).not.toContain("upsert_customer");
    expect(raw).toContain(BAFITNESS_BOOKING_URL);
    expect(raw).toContain("Quinn");
    expect(raw).not.toContain("\u2014");
    expect(raw.toLowerCase()).not.toContain("enquiry");
  });

  function taken(clinicType: string | undefined) {
    const branch = def.steps[2];
    if (branch.type !== "branch") throw new Error("expected a branch step");
    const armId = chooseBranchArm(branch, {
      vars: clinicType === undefined ? {} : { clinic_type: clinicType }
    });
    const steps =
      armId === BRANCH_ELSE_ARM
        ? branch.else
        : (branch.branches.find((arm) => arm.id === armId)?.steps ?? []);
    return { armId, steps };
  }

  it("uses the patient script when clinic_type is blank or none", () => {
    for (const clinic of ["", "   ", "none", undefined] as const) {
      const { steps } = taken(clinic);
      expect(steps[0], `clinic_type ${JSON.stringify(clinic)}`).toMatchObject({
        type: "place_ai_call",
        callWindow: {
          timezone: "America/New_York",
          start: "09:00",
          end: "18:00",
          outside: "defer"
        }
      });
      const persona = steps[0].type === "place_ai_call" ? steps[0].personaTemplate : "";
      expect(persona).toContain("patient or consumer");
      expect(persona).not.toContain("clinic Google Sheet 10-day patient script");
    }
  });

  it("uses the clinic-owner script when clinic_type is present", () => {
    const { armId, steps } = taken("Wellness clinic");
    expect(armId).toBe(BRANCH_ELSE_ARM);
    expect(steps.map((step) => step.type)).toEqual([
      "place_ai_call",
      "send_sms",
      "send_sms",
      "send_sms"
    ]);
    const persona = steps[0].type === "place_ai_call" ? steps[0].personaTemplate : "";
    expect(persona).toContain("clinic owner");
    expect(persona).toContain("partnership");
    expect(steps.slice(1).map((step) => (step.type === "send_sms" ? step.when : null))).toEqual([
      { var: "call_outcome", equals: "no_answer" },
      { var: "call_outcome", equals: "not_placed" },
      { var: "call_outcome", equals: "failed" }
    ]);
  });
});
