import { describe, expect, it } from "vitest";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  validateDefinitionSemantics
} from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

const briefFlow = (step: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
  steps: [
    {
      id: "read",
      type: "extract_text",
      fields: [{ name: "lead_notes", description: "The client notes" }]
    },
    { id: "brief", type: "voice_brief", ...step }
  ]
});

describe("voice_brief: authoring", () => {
  it("accepts a brief built from an earlier step's var", () => {
    const def = parseAiFlowDefinition(
      briefFlow({
        fromE164: "+14159851909",
        noteTemplate: "Client notes: {{vars.lead_notes}}",
        withinMinutes: 30
      })
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("scope-checks the note template like any other template", () => {
    // The whole point is briefing the call with what THIS run extracted, so a
    // typo'd var has to surface at save time rather than silently brief nothing.
    try {
      parseAiFlowDefinition(
        briefFlow({ fromE164: "+14159851909", noteTemplate: "Notes: {{vars.nope}}" })
      );
      throw new Error("expected the bad var to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AiFlowValidationError);
      expect((err as AiFlowValidationError).issues.join(" ")).toContain("nope");
    }
  });

  it("requires an E.164 caller and a non-empty note", () => {
    expect(() =>
      parseAiFlowDefinition(briefFlow({ fromE164: "4159851909", noteTemplate: "x" }))
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition(briefFlow({ fromE164: "+14159851909", noteTemplate: "" }))
    ).toThrow(AiFlowValidationError);
  });

  it("is rejected inside a voice flow (it runs on the batch worker)", () => {
    // Voice flows execute on the real-time Telnyx path, which has no worker to
    // run a brief step; the AI-first call is briefed BY an SMS-triggered flow.
    const issues = validateDefinitionSemantics({
      version: 1,
      trigger: { channel: "voice", fromE164: "+14159851909" },
      steps: [
        { id: "brief", type: "voice_brief", fromE164: "+14159851909", noteTemplate: "x" }
      ]
    } as never);
    expect(issues.join(" ")).toContain("voice flow");
  });
});

describe("voice_brief: planning", () => {
  const step = (extra: Record<string, unknown> = {}): FlowStep =>
    ({
      id: "brief",
      type: "voice_brief",
      fromE164: "+14159851909",
      noteTemplate: "Client notes: {{vars.lead_notes}}",
      ...extra
    }) as FlowStep;

  it("renders the note and defaults the window to 30 minutes", () => {
    const plan = planStep(step(), { vars: { lead_notes: "Looking for a cash offer" } });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "voice_brief",
        fromE164: "+14159851909",
        note: "Client notes: Looking for a cash offer",
        withinMinutes: 30
      }
    });
  });

  it("skips when not one var contributed, so a dry run cannot dilute the brief", () => {
    // "Client notes: {{vars.lead_notes}}" still renders its literal scaffolding
    // with nothing extracted, and briefing that would append noise to what the
    // AI already knows from the alert.
    const plan = planStep(step(), { vars: {} });
    if (!plan.ok) throw new Error("expected a planned skip, not an error");
    expect(plan.action).toMatchObject({ kind: "voice_brief", skipReason: "nothing_to_brief" });
  });

  it("skips a note that renders to nothing at all", () => {
    const plan = planStep(step({ noteTemplate: "{{vars.lead_notes}}" }), { vars: {} });
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.action).toMatchObject({ skipReason: "nothing_to_brief" });
  });

  it("briefs when any var contributed, even partially", () => {
    const plan = planStep(
      step({ noteTemplate: "Notes: {{vars.lead_notes}}. Address: {{vars.lead_address}}." }),
      { vars: { lead_address: "123 Main St" } }
    );
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.action).toMatchObject({ note: "Notes: . Address: 123 Main St." });
    expect(plan.action).not.toHaveProperty("skipReason");
  });

  it("clamps the window to the schema's bounds", () => {
    for (const [authored, expected] of [
      [0, 1],
      [500, 120],
      [45, 45]
    ] as const) {
      const plan = planStep(step({ withinMinutes: authored }), { vars: { lead_notes: "x" } });
      if (!plan.ok) throw new Error("expected ok");
      expect(plan.action).toMatchObject({ withinMinutes: expected });
    }
  });
});
