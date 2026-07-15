/**
 * Write-time validation for `run_agent` AiFlow steps.
 *
 * The schema (schema.ts) can only check SHAPE — that agentId is a uuid.
 * Whether that agent exists and is enabled requires a DB read, so the flows
 * CRUD routes and the compile pipeline call this AFTER parseAiFlowDefinition
 * (same layering as the share_document checks). The runtime re-checks at
 * execution; this validator exists so authoring mistakes surface in the
 * builder instead of as failed runs.
 */

import type { AiFlowDefinition, FlowStep } from "./schema";
import { listBusinessAgents, type BusinessAgentRow } from "@/lib/agents/db";

export type RunAgentStepRef = {
  stepId: string;
  agentId: string;
};

/** Every run_agent step in the tree (trunk + branch arms + elses). */
export function collectRunAgentSteps(def: AiFlowDefinition): RunAgentStepRef[] {
  const out: RunAgentStepRef[] = [];
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      if (step.type === "run_agent") {
        out.push({ stepId: step.id, agentId: step.agentId });
      } else if (step.type === "branch") {
        for (const arm of step.branches) walk(arm.steps);
        walk(step.else);
      }
    }
  };
  walk(def.steps);
  return out;
}

export type ValidateRunAgentDeps = {
  /** Injectable agents lookup (tests). */
  fetchAgents?: (businessId: string) => Promise<BusinessAgentRow[]>;
};

/**
 * Human-readable issues for every run_agent step whose agent is missing or
 * disabled. Empty array = valid.
 */
export async function validateRunAgentSteps(
  businessId: string,
  def: AiFlowDefinition,
  deps: ValidateRunAgentDeps = {}
): Promise<string[]> {
  const refs = collectRunAgentSteps(def);
  if (refs.length === 0) return [];
  /* c8 ignore next -- production default; tests inject fetchAgents */
  const fetchAgents = deps.fetchAgents ?? listBusinessAgents;
  const agents = await fetchAgents(businessId);
  const byId = new Map(agents.map((a) => [a.id, a]));

  const issues: string[] = [];
  for (const ref of refs) {
    const agent = byId.get(ref.agentId);
    if (!agent) {
      issues.push(
        `Step "${ref.stepId}" runs an agent that doesn't exist — pick one of your agents from /dashboard/agents.`
      );
      continue;
    }
    if (!agent.enabled) {
      issues.push(
        `Step "${ref.stepId}" runs the agent "${agent.name}", which is disabled — enable it on /dashboard/agents first.`
      );
    }
  }
  return issues;
}
