/**
 * Timing-aware AiFlow replay harness: `walkFlowTimed` executes a REAL flow
 * definition through the same shared engine modules as `walkFlow`
 * (flow-walker.ts) but models the PRODUCTION PARKING SEMANTICS the plain
 * walker cannot express — the semantics that caused the 2026-07-14 Truly
 * incident (lead Alex, run 5820f7f0):
 *
 *   - An inbound lead text is consumed by a `wait_for_reply` ONLY when the
 *     run is parked at that wait when the text arrives (the webhook resumes
 *     `status='awaiting_reply'` runs and nothing else — see
 *     telnyx-sms-inbound's wait-resume).
 *   - A `route_to_team` step PARKS the run (`awaiting_agent`) for its offer
 *     window. A lead text arriving during that park matches no wait, is
 *     never queued, and falls through to the generic AI reply path.
 *
 * `walkFlow` treats route_to_team as instant, so a scripted reply is always
 * consumed by the next wait — which is exactly how the existing engine e2e
 * stayed green while production dropped Alex's "July 23, 2026" renewal
 * answer: the flow's wait_renewal sat AFTER route_to_team, the run was
 * parked on the agent offer when the answer arrived, and the wait later
 * timed out.
 *
 * The virtual clock is in minutes since run start. Non-parking steps take
 * zero time; a wait_for_reply advances to the consumed message's arrival
 * (or its timeout); a route_to_team advances by its responseMinutes (one
 * un-claimed offer window — production escalates through the roster, which
 * only widens the fall-through window, so one window is the CONSERVATIVE
 * model).
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
import type { SimulatedSend, WalkedStep } from "./flow-walker";

/** One lead text with its arrival time on the virtual clock. */
export type TimedInbound = {
  text: string;
  /** Minutes since the run started. */
  atMinutes: number;
};

/** A lead text no wait_for_reply was parked for — the generic-AI-path class. */
export type FellThroughInbound = TimedInbound & {
  /**
   * The step the run was parked at when the text arrived (`route_to_team`
   * offers are the incident class), or null when it arrived between parks.
   */
  parkedAtStepId: string | null;
};

export type TimedWalkResult = {
  steps: WalkedStep[];
  vars: Record<string, unknown>;
  /** Every send_sms the flow would have fired, fully rendered. */
  sends: SimulatedSend[];
  /**
   * Lead texts the FLOW never owned: in production each of these got a
   * generic AI reply with no flow state. The renewal-deadline contract is
   * that this stays EMPTY for the intake conversation.
   */
  fellThroughToGenericPath: FellThroughInbound[];
  /** Lead texts arriving after the walk finished (a finished run hands the
   * thread back to the generic assistant legitimately — not a violation). */
  arrivedAfterRun: TimedInbound[];
  endedAtMinutes: number;
};

export type TimedWalkOptions = {
  /** The run's trigger scope (windowText carries the triggering message). */
  trigger: Record<string, unknown>;
  /** Lead texts in chronological order of arrival. */
  inbound: TimedInbound[];
  /** Live model adapter (tests/e2e/gemini.ts geminiJson). */
  ai: { json(prompt: string): Promise<string> };
};

export async function walkFlowTimed(
  steps: FlowStep[],
  opts: TimedWalkOptions
): Promise<TimedWalkResult> {
  const scope: StepScope & { vars: Record<string, unknown> } = {
    vars: {},
    trigger: opts.trigger
  };
  const pending = [...opts.inbound].sort((a, b) => a.atMinutes - b.atMinutes);
  const walked: WalkedStep[] = [];
  const sends: SimulatedSend[] = [];
  const fellThrough: FellThroughInbound[] = [];
  let clock = 0;

  const record = (
    step: FlowStep,
    status: WalkedStep["status"],
    result: Record<string, unknown>
  ) => walked.push({ id: step.id, type: step.type, status, result });

  /** Divert every pending text that arrived strictly before `t`. */
  const divertBefore = (t: number, parkedAtStepId: string | null) => {
    while (pending.length > 0 && pending[0].atMinutes < t) {
      fellThrough.push({ ...pending.shift()!, parkedAtStepId });
    }
  };

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
      throw new Error(`walkFlowTimed: step "${step.id}" failed to plan: ${plan.error}`);
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
        // Texts that arrived before this park started were never queued for
        // it — in production they already went to the generic path.
        divertBefore(clock, null);
        const next = pending[0];
        if (next && next.atMinutes <= clock + action.timeoutMinutes) {
          pending.shift();
          clock = Math.max(clock, next.atMinutes);
          scope.vars[action.saveAs] = next.text;
          scope.vars[action.marker] = "1";
          record(step, "done", {
            saved: { [action.saveAs]: next.text },
            consumed_at_minutes: clock
          });
        } else {
          clock += action.timeoutMinutes;
          scope.vars[action.saveAs] = NO_REPLY_SENTINEL;
          scope.vars[action.marker] = "1";
          record(step, "done", {
            saved: { [action.saveAs]: NO_REPLY_SENTINEL },
            timed_out_at_minutes: clock
          });
        }
        break;
      }
      case "route_to_team": {
        // The run parks awaiting_agent for the offer window; every lead text
        // arriving inside it falls through to the generic path (the
        // incident). The window resolves un-claimed (owner fallback) — a
        // claim would only shorten it.
        divertBefore(clock, null);
        const windowEnd = clock + action.responseMinutes;
        divertBefore(windowEnd, step.id);
        clock = windowEnd;
        const simulated = simulateTestAction(action, scope);
        record(step, "done", {
          ...(simulated ?? { simulated: "route_to_team" }),
          parked_from_minutes: windowEnd - action.responseMinutes,
          parked_until_minutes: windowEnd
        });
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
            `walkFlowTimed: step "${step.id}" planned unsupported action kind "${action.kind}"`
          );
        }
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

  return {
    steps: walked,
    vars: scope.vars,
    sends,
    fellThroughToGenericPath: fellThrough,
    arrivedAfterRun: pending,
    endedAtMinutes: clock
  };
}
