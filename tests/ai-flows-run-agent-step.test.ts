/**
 * run_agent AiFlow step — schema, scope rules, planner, test-mode
 * simulation, library scrub, and compile-prompt awareness. One suite so
 * the whole step contract (authoring → validation → execution planning)
 * is pinned in one place.
 */
import { describe, expect, it } from "vitest";

import {
  aiFlowDefinitionSchema,
  parseAiFlowDefinition,
  validateDefinitionSemantics
} from "@/lib/ai-flows/schema";
import { varsProducedByStep } from "@/lib/ai-flows/tree";
import { scrubDefinition } from "@/lib/ai-flows/scrub";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildAvailableAgentsBlock,
  buildFlowCompileUserText,
  buildFlowRepairUserText
} from "@/lib/ai-flows/compile";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import { simulateTestAction } from "../supabase/functions/_shared/ai_flows/test_mode";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function runAgentDef(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "s1",
        type: "run_agent",
        agentId: AGENT_ID,
        agentName: "Intake summarizer",
        input: "{{trigger.windowText}}",
        saveAs: "agent_output",
        ...overrides
      },
      { id: "s2", type: "notify_owner", message: "Result: {{vars.agent_output}}" }
    ]
  };
}

describe("run_agent — schema + scope rules", () => {
  it("parses a valid step and exposes saveAs to later steps", () => {
    const def = parseAiFlowDefinition(runAgentDef());
    expect(def.steps[0]).toMatchObject({ type: "run_agent", agentId: AGENT_ID });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects a non-uuid agentId and a missing input/saveAs", () => {
    expect(() => parseAiFlowDefinition(runAgentDef({ agentId: "nope" }))).toThrow();
    expect(() => parseAiFlowDefinition(runAgentDef({ input: "" }))).toThrow();
    expect(() => parseAiFlowDefinition(runAgentDef({ saveAs: undefined }))).toThrow();
  });

  it("requires exactly one of input / documentTemplate", () => {
    // Neither source: the step has nothing to run on.
    const neither = aiFlowDefinitionSchema.parse(runAgentDef({ input: undefined }));
    expect(
      validateDefinitionSemantics(neither).some((i) => i.includes("nothing to run it on"))
    ).toBe(true);
    // Both sources: ambiguous.
    const both = aiFlowDefinitionSchema.parse(
      runAgentDef({ documentTemplate: "{{trigger.document}}" })
    );
    expect(validateDefinitionSemantics(both).some((i) => i.includes("use only one"))).toBe(true);
    // Document mode alone parses clean.
    const def = parseAiFlowDefinition(
      runAgentDef({ input: undefined, documentTemplate: "{{trigger.document}}" })
    );
    expect(def.steps[0]).toMatchObject({ type: "run_agent", documentTemplate: "{{trigger.document}}" });
  });

  it("saveDocument parses and its title template is scope-checked", () => {
    const def = parseAiFlowDefinition(
      runAgentDef({ saveDocument: { titleTemplate: "Comparison — {{trigger.document_name}}" } })
    );
    expect(def.steps[0]).toMatchObject({
      saveDocument: { titleTemplate: "Comparison — {{trigger.document_name}}" }
    });
    const bad = aiFlowDefinitionSchema.parse(
      runAgentDef({ saveDocument: { titleTemplate: "{{vars.never_produced}}" } })
    );
    expect(validateDefinitionSemantics(bad).some((i) => i.includes("never_produced"))).toBe(true);
  });

  it("saveDocument exposes the filed-document vars to later steps", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "s1",
          type: "run_agent",
          agentId: AGENT_ID,
          input: "{{trigger.windowText}}",
          saveDocument: { titleTemplate: "Output" },
          saveAs: "agent_output"
        },
        {
          id: "s2",
          type: "notify_owner",
          message: "Filed {{vars.agent_output_document_title}} ({{vars.agent_output_document_id}})"
        }
      ]
    });
    expect(validateDefinitionSemantics(def)).toEqual([]);
    expect(varsProducedByStep(def.steps[0])).toEqual([
      "agent_output",
      "agent_output_document_id",
      "agent_output_document_title"
    ]);
  });

  it("scope-checks the input template like any other template", () => {
    // Schema-only parse: parseAiFlowDefinition would throw on the semantic
    // issue we want to inspect.
    const def = aiFlowDefinitionSchema.parse(runAgentDef({ input: "{{vars.never_produced}}" }));
    const issues = validateDefinitionSemantics(def);
    expect(issues.some((i) => i.includes("never_produced"))).toBe(true);
  });

  it("varsProducedByStep reports the saveAs var (editor pickers)", () => {
    const def = parseAiFlowDefinition(runAgentDef());
    expect(varsProducedByStep(def.steps[0])).toEqual(["agent_output"]);
  });
});

describe("run_agent — library scrub", () => {
  it("blanks the tenant-specific agent binding to the nil uuid", () => {
    const def = parseAiFlowDefinition(runAgentDef());
    const scrubbed = scrubDefinition(def) as { steps: Array<Record<string, unknown>> };
    expect(scrubbed.steps[0].agentId).toBe("00000000-0000-0000-0000-000000000000");
    expect(scrubbed.steps[0].agentName).toBeUndefined();
  });
});

describe("run_agent — compile prompt awareness", () => {
  it("the system prompt teaches the step with the NEVER-invent contract", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"type":"run_agent"');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("AVAILABLE AGENTS");
    // Document mode + filing are taught alongside the text mode.
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"documentTemplate":"{{trigger.document}}"');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"saveDocument"');
  });

  it("buildAvailableAgentsBlock lists agents or forbids the step", () => {
    expect(buildAvailableAgentsBlock([])).toContain("do not emit run_agent steps");
    const block = buildAvailableAgentsBlock([
      { id: AGENT_ID, name: "Intake summarizer", instructionsSummary: "Summarize intake forms" }
    ]);
    expect(block).toContain(AGENT_ID);
    expect(block).toContain("Intake summarizer");
    expect(block).toContain("Summarize intake forms");
    expect(
      buildAvailableAgentsBlock([{ id: AGENT_ID, name: "A", instructionsSummary: "" }])
    ).not.toContain('": "');
  });

  it("compile and repair user texts carry the agents block", () => {
    const agents = [{ id: AGENT_ID, name: "A", instructionsSummary: "s" }];
    expect(buildFlowCompileUserText("desc", [], agents)).toContain(AGENT_ID);
    expect(buildFlowCompileUserText("desc")).toContain("none saved");
    expect(
      buildFlowRepairUserText({ description: "d", candidateJson: "{}", issues: ["x"], agents })
    ).toContain(AGENT_ID);
    expect(
      buildFlowRepairUserText({ description: "d", candidateJson: "{}", issues: ["x"] })
    ).toContain("none saved");
  });
});

describe("run_agent — planner (planStep)", () => {
  const step: FlowStep = {
    id: "s1",
    type: "run_agent",
    agentId: AGENT_ID,
    agentName: "Intake summarizer",
    input: "Summarize: {{vars.lead_notes}}",
    saveAs: "agent_output"
  };

  it("renders the input and plans the action", () => {
    const plan = planStep(step, { vars: { lead_notes: "called twice" }, trigger: {} });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "run_agent",
        agentId: AGENT_ID,
        agentName: "Intake summarizer",
        input: "Summarize: called twice",
        saveAs: "agent_output"
      }
    });
  });

  it("plans a SKIP when a templated input renders empty (lead-data gap)", () => {
    const plan = planStep({ ...step, input: "{{vars.lead_notes}}" }, { vars: {}, trigger: {} });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "run_agent",
        agentId: AGENT_ID,
        agentName: "Intake summarizer",
        input: "",
        saveAs: "agent_output",
        skipReason: "no_input"
      }
    });
  });

  it("fails hard on a LITERAL input that renders empty (config bug, not a data gap)", () => {
    const plan = planStep({ ...step, input: "   " }, { vars: {}, trigger: {} });
    expect(plan).toEqual({ ok: false, error: "run_agent: input is empty after templating" });
  });

  it("omits the optional agentName from the action when absent", () => {
    const { agentName: _drop, ...noName } = step;
    const plan = planStep(noName as FlowStep, { vars: {}, trigger: { windowText: "hi" } });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.action.kind === "run_agent") {
      expect("agentName" in plan.action).toBe(false);
    }
  });

  it("document mode plans the rendered ref (default {{trigger.document}})", () => {
    const docStep: FlowStep = {
      id: "s1",
      type: "run_agent",
      agentId: AGENT_ID,
      documentTemplate: "{{trigger.document}}",
      saveAs: "agent_output"
    };
    const plan = planStep(docStep, {
      vars: {},
      trigger: { document: "email-attachments:inbound/m1/0-quotes.pdf" }
    });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "run_agent",
        agentId: AGENT_ID,
        input: "",
        documentRef: "email-attachments:inbound/m1/0-quotes.pdf",
        saveAs: "agent_output"
      }
    });
  });

  it("document mode is the default when neither input nor documentTemplate is set", () => {
    const bare = {
      id: "s1",
      type: "run_agent",
      agentId: AGENT_ID,
      saveAs: "agent_output"
    } as FlowStep;
    const plan = planStep(bare, {
      vars: {},
      trigger: { document: "email-attachments:inbound/m1/0-quotes.pdf" }
    });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.action.kind === "run_agent") {
      expect(plan.action.documentRef).toBe("email-attachments:inbound/m1/0-quotes.pdf");
    }
  });

  it("document mode SKIPS when the trigger carries no document", () => {
    const docStep: FlowStep = {
      id: "s1",
      type: "run_agent",
      agentId: AGENT_ID,
      documentTemplate: "{{trigger.document}}",
      saveAs: "agent_output"
    };
    const plan = planStep(docStep, { vars: {}, trigger: {} });
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "run_agent",
        agentId: AGENT_ID,
        input: "",
        saveAs: "agent_output",
        skipReason: "no document on this trigger to run on"
      }
    });
  });

  it("saveDocument renders the filing title (blank render keeps filing intent)", () => {
    const withSave: FlowStep = {
      ...step,
      saveDocument: { titleTemplate: "Comparison — {{vars.customer}}" }
    };
    const rendered = planStep(withSave, {
      vars: { lead_notes: "x", customer: "Pat" },
      trigger: {}
    });
    expect(rendered.ok).toBe(true);
    if (rendered.ok && rendered.action.kind === "run_agent") {
      expect(rendered.action.saveTitle).toBe("Comparison — Pat");
    }

    const blankTitle = planStep(
      { ...withSave, saveDocument: { titleTemplate: "{{vars.customer}}" } } as FlowStep,
      { vars: { lead_notes: "x" }, trigger: {} }
    );
    expect(blankTitle.ok).toBe(true);
    if (blankTitle.ok && blankTitle.action.kind === "run_agent") {
      expect(blankTitle.action.saveTitle).toBe("Agent output");
    }

    const docWithSave = planStep(
      {
        id: "s1",
        type: "run_agent",
        agentId: AGENT_ID,
        documentTemplate: "{{trigger.document}}",
        saveDocument: { titleTemplate: "Filed" },
        saveAs: "agent_output"
      } as FlowStep,
      { vars: {}, trigger: { document: "email-attachments:a/0-b.pdf" } }
    );
    expect(docWithSave.ok).toBe(true);
    if (docWithSave.ok && docWithSave.action.kind === "run_agent") {
      expect(docWithSave.action).toMatchObject({
        documentRef: "email-attachments:a/0-b.pdf",
        saveTitle: "Filed"
      });
    }
  });
});

describe("run_agent — test-mode simulation", () => {
  it("simulates without a model call and stamps a visible placeholder", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const simulated = simulateTestAction(
      {
        kind: "run_agent",
        agentId: AGENT_ID,
        agentName: "Intake summarizer",
        input: "text",
        saveAs: "agent_output"
      },
      scope
    );
    expect(simulated).toMatchObject({ simulated: "run_agent", agentId: AGENT_ID });
    expect(scope.vars.agent_output).toContain("placeholder");
  });

  it("simulates without an agentName too", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const simulated = simulateTestAction(
      { kind: "run_agent", agentId: AGENT_ID, input: "text", saveAs: "agent_output" },
      scope
    );
    expect(simulated).toEqual({ simulated: "run_agent", agentId: AGENT_ID, input: "text" });
  });

  it("simulated skips read as skips and stamp the vars empty (live-run parity)", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const simulated = simulateTestAction(
      { kind: "run_agent", agentId: AGENT_ID, input: "", saveAs: "agent_output", skipReason: "no_input" },
      scope
    );
    expect(simulated).toEqual({ simulated: "run_agent", skipped: "no_input" });
    // The live skip path sets {{vars.agent_output}} = "" (and the filed-doc
    // linkage vars) — the simulation must match so when-guards behave
    // identically in test and production.
    expect(scope.vars.agent_output).toBe("");
    expect(scope.vars.agent_output_document_id).toBe("");
    expect(scope.vars.agent_output_document_title).toBe("");
  });

  it("document mode reports the ref it would read and the filing title", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const simulated = simulateTestAction(
      {
        kind: "run_agent",
        agentId: AGENT_ID,
        input: "",
        documentRef: "email-attachments:a/0-b.pdf",
        saveTitle: "Comparison",
        saveAs: "agent_output"
      },
      scope
    );
    expect(simulated).toEqual({
      simulated: "run_agent",
      agentId: AGENT_ID,
      document: "email-attachments:a/0-b.pdf",
      would_file_as: "Comparison"
    });
    expect(scope.vars.agent_output).toContain("placeholder");
    // No document is filed in test mode; the title var mirrors intent.
    expect(scope.vars.agent_output_document_id).toBe("");
    expect(scope.vars.agent_output_document_title).toBe("Comparison");
  });
});
