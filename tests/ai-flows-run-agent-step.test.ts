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

  it("simulated skips read as skips (no placeholder stamped)", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const simulated = simulateTestAction(
      { kind: "run_agent", agentId: AGENT_ID, input: "", saveAs: "agent_output", skipReason: "no_input" },
      scope
    );
    expect(simulated).toEqual({ simulated: "run_agent", skipped: "no_input" });
    expect(scope.vars.agent_output).toBeUndefined();
  });
});
