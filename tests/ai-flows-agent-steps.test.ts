/**
 * Write-time validation for run_agent AiFlow steps
 * (src/lib/ai-flows/agent-steps.ts): tree-wide collection (branch arms
 * included) and the exists/enabled checks against the business's agents.
 */
import { describe, expect, it } from "vitest";
import { collectRunAgentSteps, validateRunAgentSteps } from "@/lib/ai-flows/agent-steps";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";
import type { BusinessAgentRow } from "@/lib/agents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function agent(overrides: Partial<BusinessAgentRow> = {}): BusinessAgentRow {
  return {
    id: AGENT_ID,
    business_id: BIZ,
    name: "Intake summarizer",
    instructions: "Summarize.",
    output_format: "markdown",
    enabled: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function defWithRunAgent(agentId: string): AiFlowDefinition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "s1", type: "run_agent", agentId, input: "{{trigger.windowText}}", saveAs: "out" }
    ]
  } as AiFlowDefinition;
}

describe("collectRunAgentSteps", () => {
  it("walks trunk, branch arms, and else paths", () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "t1", type: "extract_text", fields: [{ name: "x" }] },
        { id: "t2", type: "run_agent", agentId: "a-1", input: "{{vars.x}}", saveAs: "o1" },
        {
          id: "b1",
          type: "branch",
          question: "?",
          branches: [
            {
              id: "arm1",
              label: "A",
              condition: { var: "x", equals: "y" },
              steps: [{ id: "a1", type: "run_agent", agentId: "a-2", input: "{{vars.x}}", saveAs: "o2" }]
            }
          ],
          else: [{ id: "e1", type: "run_agent", agentId: "a-3", input: "{{vars.x}}", saveAs: "o3" }]
        }
      ]
    } as unknown as AiFlowDefinition;
    expect(collectRunAgentSteps(def)).toEqual([
      { stepId: "t2", agentId: "a-1" },
      { stepId: "a1", agentId: "a-2" },
      { stepId: "e1", agentId: "a-3" }
    ]);
  });
});

describe("validateRunAgentSteps", () => {
  it("skips the DB read entirely when the flow has no run_agent steps", async () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "s1", type: "notify_owner", message: "hi" }]
    } as unknown as AiFlowDefinition;
    const fetchAgents = async () => {
      throw new Error("must not be called");
    };
    expect(await validateRunAgentSteps(BIZ, def, { fetchAgents })).toEqual([]);
  });

  it("flags an agent that doesn't exist", async () => {
    const issues = await validateRunAgentSteps(
      BIZ,
      defWithRunAgent("99999999-9999-4999-8999-999999999999"),
      { fetchAgents: async () => [agent()] }
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("doesn't exist");
  });

  it("flags a disabled agent by name", async () => {
    const issues = await validateRunAgentSteps(BIZ, defWithRunAgent(AGENT_ID), {
      fetchAgents: async () => [agent({ enabled: false })]
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"Intake summarizer"');
    expect(issues[0]).toContain("disabled");
  });

  it("passes an existing, enabled agent", async () => {
    const issues = await validateRunAgentSteps(BIZ, defWithRunAgent(AGENT_ID), {
      fetchAgents: async () => [agent()]
    });
    expect(issues).toEqual([]);
  });
});
