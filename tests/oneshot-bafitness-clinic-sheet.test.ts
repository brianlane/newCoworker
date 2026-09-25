import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { BRANCH_ELSE_ARM, chooseBranchArm } from "../supabase/functions/_shared/ai_flows/branching";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import {
  BAFITNESS_BOOKING_URL,
  BAFITNESS_CALL_DELAY_MINUTES,
  BAFITNESS_CLINIC_SOURCE,
  BAFITNESS_WELCOME_FROM_CONNECTION_ID,
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
    expect(def.steps[2]).toMatchObject({ type: "sleep", minutes: BAFITNESS_CALL_DELAY_MINUTES });
    expect(BAFITNESS_CALL_DELAY_MINUTES).toBe(7);
  });

  it("calls Dane on Pacific time and everyone else on Eastern, and does not create a contact", () => {
    const branch = def.steps[3];
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

  function taken(clinic: string | undefined) {
    const branch = def.steps[3];
    if (branch.type !== "branch") throw new Error("expected a branch step");
    const armId = chooseBranchArm(branch, {
      vars: clinic === undefined ? {} : { clinic_name: clinic }
    });
    const steps =
      armId === BRANCH_ELSE_ARM
        ? branch.else
        : (branch.branches.find((arm) => arm.id === armId)?.steps ?? []);
    return { armId, steps };
  }

  it("notifies and does not dial when the clinic name is blank or none", () => {
    // extract_text writes "" when the field is absent. equals "none" does not
    // match that, so the old arm never won and the Eastern call ran instead.
    for (const clinic of ["", "   ", "none", "None", undefined] as const) {
      const { steps } = taken(clinic);
      expect(steps[0], `clinic ${JSON.stringify(clinic)}`).toMatchObject({ type: "notify_owner" });
      expect(steps.some((step) => step.type === "place_ai_call")).toBe(false);
    }
  });

  it("emails from the connected mailbox when an address is present, then texts only if the call never connected", () => {
    const email = def.steps[1];
    expect(email.type).toBe("branch");
    if (email.type !== "branch") return;
    expect(email.branches[0].steps).toEqual([]);
    expect(email.else[0]).toMatchObject({
      type: "send_email",
      to: "{{vars.lead_email}}",
      fromConnectionId: BAFITNESS_WELCOME_FROM_CONNECTION_ID
    });
    const dane = taken("Dane Functional Health");
    expect(dane.steps.map((step) => step.type)).toEqual([
      "place_ai_call",
      "send_sms",
      "send_sms",
      "send_sms"
    ]);
    expect(dane.steps.slice(1).map((step) => (step.type === "send_sms" ? step.when : null))).toEqual([
      { var: "call_outcome", equals: "no_answer" },
      { var: "call_outcome", equals: "not_placed" },
      { var: "call_outcome", equals: "failed" }
    ]);
    expect(JSON.stringify(dane.steps)).toContain(BAFITNESS_BOOKING_URL);
    const eros = taken("Eros Vitality");
    expect(eros.armId).toBe(BRANCH_ELSE_ARM);
    expect(eros.steps[0]).toMatchObject({
      type: "place_ai_call",
      callWindow: { timezone: "America/New_York" }
    });
    const jersey = taken("New Jersey Weight Loss Company");
    expect(jersey.armId).toBe(BRANCH_ELSE_ARM);
    expect(jersey.steps[0]).toMatchObject({
      type: "place_ai_call",
      callWindow: { timezone: "America/New_York" }
    });
  });
});

describe("evaluateStepCondition blank", () => {
  it("matches only a missing or whitespace-only value", () => {
    expect(evaluateStepCondition({ var: "clinic_name", blank: true }, { vars: { clinic_name: "" } })).toBe(
      true
    );
    expect(
      evaluateStepCondition({ var: "clinic_name", blank: true }, { vars: { clinic_name: "   " } })
    ).toBe(true);
    expect(evaluateStepCondition({ var: "clinic_name", blank: true }, { vars: {} })).toBe(true);
    expect(
      evaluateStepCondition({ var: "clinic_name", blank: true }, { vars: { clinic_name: "none" } })
    ).toBe(false);
    expect(
      evaluateStepCondition({ var: "clinic_name", blank: true }, { vars: { clinic_name: "Eros Vitality" } })
    ).toBe(false);
  });
});
