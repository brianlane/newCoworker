/**
 * E2E flow walker: executes a REAL AiFlow definition through the REAL shared
 * engine modules — flattenSteps ordering, isOnActivePath branch skips,
 * per-step `when` guards, planStep templating/validation, chooseBranchArm
 * (via planStep's branch case), and simulateTestAction side-effect capture —
 * with LIVE model calls for classify / extract_text.
 *
 * This deliberately reuses the same modules the ai-flow-worker imports; the
 * only harness-owned code is this loop, which mirrors executeRun's step
 * semantics (see supabase/functions/ai-flow-worker/index.ts):
 *   1. a step under an untaken branch arm is skipped (branch_not_taken);
 *   2. a step whose `when` is unmet is skipped (when_unmet);
 *   3. planStep decides the action; a plan failure fails the walk loudly
 *      (an e2e fixture must always plan cleanly);
 *   4. wait_for_reply resolves from the scripted replies (null = timeout →
 *      NO_REPLY_SENTINEL) exactly like the resume/timeout paths stamp vars;
 *   5. classify/extract call the real model with the worker's exact prompts
 *      and parsers; everything side-effecting goes through simulateTestAction
 *      (the same simulation the production test-run feature uses).
 *
 * What this cannot cover (and why the unit/DB layers still matter): run
 * persistence, revision races, quiet-hour deferrals, goal jumps from
 * external events, and Telnyx/Rowboat IO.
 */
import {
  flattenSteps,
  isOnActivePath
} from "../../supabase/functions/_shared/ai_flows/branching";
import {
  buildClassifyPrompt,
  buildExtractionPrompt,
  evaluateStepCondition,
  extractLabeledPhones,
  isPhoneFieldName,
  parseClassifyChoice,
  parseExtractionJson
} from "../../supabase/functions/_shared/ai_flows/engine";
import {
  NO_REPLY_SENTINEL,
  planStep,
  type StepScope
} from "../../supabase/functions/_shared/ai_flows/steps";
import { simulateTestAction } from "../../supabase/functions/_shared/ai_flows/test_mode";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";

export type WalkedStep = {
  id: string;
  type: string;
  status: "done" | "skipped";
  result: Record<string, unknown>;
};

export type SimulatedSend = { to: string; body: string };

export type WalkResult = {
  steps: WalkedStep[];
  vars: Record<string, unknown>;
  /** Every send_sms the flow would have fired, fully rendered. */
  sends: SimulatedSend[];
};

export type WalkOptions = {
  /** The run's trigger scope (windowText carries the triggering message). */
  trigger: Record<string, unknown>;
  /**
   * Scripted lead replies consumed by wait_for_reply steps in order;
   * null (or exhaustion) = the wait times out → NO_REPLY_SENTINEL.
   */
  replies?: Array<string | null>;
  /** Live model adapter (tests/e2e/gemini.ts geminiJson). */
  ai: { json(prompt: string): Promise<string> };
};

export async function walkFlow(
  steps: FlowStep[],
  opts: WalkOptions
): Promise<WalkResult> {
  const scope: StepScope & { vars: Record<string, unknown> } = {
    vars: {},
    trigger: opts.trigger
  };
  const replies = [...(opts.replies ?? [])];
  const walked: WalkedStep[] = [];
  const sends: SimulatedSend[] = [];

  const record = (
    step: FlowStep,
    status: WalkedStep["status"],
    result: Record<string, unknown>
  ) => walked.push({ id: step.id, type: step.type, status, result });

  for (const entry of flattenSteps(steps)) {
    const step = entry.step;
    if (entry.branchPath.length > 0 && !isOnActivePath(entry.branchPath, scope.vars)) {
      record(step, "skipped", { skipped: "branch_not_taken" });
      continue;
    }
    if (step.when && !evaluateStepCondition(step.when, scope)) {
      record(step, "skipped", { skipped: "when_unmet" });
      continue;
    }
    const plan = planStep(step, scope);
    if (!plan.ok) {
      throw new Error(`walkFlow: step "${step.id}" failed to plan: ${plan.error}`);
    }
    const action = plan.action;
    switch (action.kind) {
      case "set_vars": {
        Object.assign(scope.vars, action.vars);
        record(step, "done", { vars: action.vars });
        break;
      }
      case "classify": {
        if (action.resolved !== undefined) {
          scope.vars[action.saveAs] = action.resolved;
          record(step, "done", { [action.saveAs]: action.resolved, pre_resolved: true });
          break;
        }
        const raw = await opts.ai.json(
          buildClassifyPrompt(action.categories, action.text, action.question)
        );
        const choice = parseClassifyChoice(raw, action.categories);
        scope.vars[action.saveAs] = choice;
        record(step, "done", { [action.saveAs]: choice });
        break;
      }
      case "extract_text": {
        const raw = await opts.ai.json(buildExtractionPrompt(action.fields, action.text));
        const extracted = parseExtractionJson(raw, action.fields);
        const out: Record<string, string> = {};
        for (const f of action.fields) {
          // Mirror the worker's regex fallback for phone fields (labeled
          // numbers only — see extractLabeledPhones).
          let val = extracted[f.name] ?? "";
          if (!val && isPhoneFieldName(f.name)) {
            val = extractLabeledPhones(action.text)[0] ?? "";
          }
          out[f.name] = val;
        }
        Object.assign(scope.vars, out);
        record(step, "done", { vars: out });
        break;
      }
      case "wait_for_reply": {
        const reply = replies.length > 0 ? replies.shift()! : null;
        scope.vars[action.saveAs] = reply ?? NO_REPLY_SENTINEL;
        scope.vars[action.marker] = "1";
        record(step, "done", { saved: { [action.saveAs]: scope.vars[action.saveAs] } });
        break;
      }
      case "goal": {
        record(step, "done", { goal: action.label, reached_via: action.reachedVia });
        break;
      }
      default: {
        const simulated = simulateTestAction(action, scope);
        if (!simulated) {
          throw new Error(
            `walkFlow: step "${step.id}" planned unsupported action kind "${action.kind}"`
          );
        }
        // A simulated planner skip (e.g. no usable recipient) mirrors the
        // worker: recorded as skipped, and never counted as a send.
        if (typeof simulated.skipped === "string") {
          record(step, "skipped", simulated);
          break;
        }
        if (simulated.simulated === "send_sms") {
          sends.push({ to: String(simulated.to ?? ""), body: String(simulated.body ?? "") });
        }
        record(step, "done", simulated);
        break;
      }
    }
  }
  return { steps: walked, vars: scope.vars, sends };
}

/** The walked record for a step id (throws on a typo so tests stay honest). */
export function stepOf(result: WalkResult, id: string): WalkedStep {
  const found = result.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no walked step with id "${id}"`);
  return found;
}
