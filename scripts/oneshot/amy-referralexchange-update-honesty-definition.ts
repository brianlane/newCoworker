/**
 * Pure builder: stop Amy's ReferralExchange update from claiming "no interaction
 * yet" on a lead the same run just spoke to.
 *
 * THE PROBLEM. `re_update` posts onto the referral's ReferralExchange timeline,
 * and it always posts the same status:
 *
 *   click_text     "Leave an update"
 *   click_text     "No interaction yet"
 *   click_text     "I am still trying to contact"
 *   fill_selector  textarea[name="message"]
 *   click_selector .update-status-container .submit.action-details button
 *
 * The very same run can place an AI call, have it ANSWERED or warm-TRANSFERRED
 * to Amy's team minutes earlier, and still tell ReferralExchange that nobody has
 * been reached. RE decides referral quality and volume from these updates, so an
 * understated status is not a cosmetic problem.
 *
 * THE MODAL, read live on 2026-08-17 (probe against a real referral page, with
 * nothing submitted). Step 1 offers five statuses, and choosing one reveals its
 * own sub-options:
 *
 *   No interaction yet
 *     -> I am still trying to contact <FirstName>
 *   We are in contact
 *     -> I have an appointment with <FirstName>
 *     -> <FirstName> is open to working with me
 *     -> <FirstName> does not want to work with me
 *   Listing / showing properties
 *   Transaction in progress
 *   No longer working this referral
 *
 * A sub-option is REQUIRED: with "We are in contact" selected and no sub-option,
 * the submit button keeps its `disabled` attribute; adding "is open to working
 * with me" removes it (both states verified live, and the probe reported 3 of 3
 * actions completed).
 *
 * WHY "is open to working with me" AND NOT ONE OF THE OTHER TWO. The three
 * sub-options are appointment-booked, still-working-it, and refused. The other
 * two are terminal claims this flow cannot make: it has not booked anything, and
 * a refusal would have shown up in the call classification. "Open to working
 * with me" is RE's own residual "we reached them and are still working it",
 * which is exactly what an answered or transferred call means. It is the least
 * overclaiming option RE's taxonomy actually offers; there is no
 * "spoke, outcome unknown".
 *
 * The sub-option labels embed the lead's FIRST NAME, so they are matched by the
 * stable fragment ("is open to working with me"), never the whole label. That is
 * the same substring behavior the existing "I am still trying to contact" click
 * already relies on.
 *
 * SHAPE. `re_update` is wrapped in a new branch that keeps `re_update` itself,
 * unchanged and under its own id, on the `else` path. A parked run stores its
 * cursor as a step id and `resolveResumeIndex` STOPS the run when that id is
 * gone, so the id must survive. This is the same wrap-without-renaming pattern
 * `rt_route_gate` uses on the Realtor.com flow.
 *
 * Two arms rather than one, because the two reached-outcomes are distinct enum
 * values and the flow already branches on them exactly this way elsewhere
 * (`{"var":"call_outcome","equals":"transferred"}` and `..."answered"`). A single
 * `contains` needle covering both would have to be a fragment like "ered", which
 * is unreadable and would quietly also match nothing useful. Both arms are
 * generated from ONE action list here, so they cannot drift apart in source.
 *
 * Deliberately NOT gated on `notEquals: "no_answer"`: a call skipped by the
 * calling window resolves to `not_placed`, not `no_answer`, so a negative gate
 * would post "we are in contact" for a call that was never dialed.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** The live step this wraps. Its id must never change. */
export const UPDATE_STEP_ID = "re_update";
/** The branch that now holds it. */
export const GATE_STEP_ID = "re_update_gate";

/** Arm ids and the outcome each answers to. */
export const REACHED_ARMS = [
  { id: "re_upd_answered", outcome: "answered", stepId: "re_update_spoke" },
  { id: "re_upd_transferred", outcome: "transferred", stepId: "re_update_spoke_transferred" }
] as const;

/** The var the flow's own AI-call steps already write. */
export const OUTCOME_VAR = "call_outcome";

/** Verbatim modal labels, and the stable fragments the actions match on. */
export const STATUS_IN_CONTACT = "We are in contact";
export const SUBSTATUS_OPEN = "is open to working with me";
export const STATUS_NO_INTERACTION = "No interaction yet";

/**
 * The note posted alongside the reached status. `actions_taken` is an
 * engine-provided running log of what the run actually did, which is what keeps
 * the note honest without anyone maintaining it.
 */
export const SPOKE_NOTE =
  "Update from Amy's assistant: {{vars.actions_taken}}. We connected with the client by phone and are continuing to follow up.";

/** Submit control, unchanged from the step this mirrors. */
const SUBMIT_SELECTOR = ".update-status-container .submit.action-details button";

/** The five actions that post a "we are in contact" update. */
export function spokeActions(): Array<Record<string, string>> {
  return [
    { kind: "click_text", target: "Leave an update" },
    { kind: "click_text", target: STATUS_IN_CONTACT },
    { kind: "click_text", target: SUBSTATUS_OPEN },
    { kind: "fill_selector", target: 'textarea[name="message"]', valueTemplate: SPOKE_NOTE },
    { kind: "click_selector", target: SUBMIT_SELECTOR }
  ];
}

/** Find the trunk index of a step id, or -1. */
function indexOf(def: AiFlowDefinition, id: string): number {
  return def.steps.findIndex((s) => s.id === id);
}

/**
 * Wrap `re_update` in `re_update_gate`. Returns the ids added, or [] when the
 * gate is already there.
 *
 * Throws rather than guessing when `re_update` is missing or already nested:
 * a silent no-op here would look like "already applied" and leave the flow
 * posting the understated status forever.
 */
export function addUpdateHonestyGate(def: AiFlowDefinition): string[] {
  if (indexOf(def, GATE_STEP_ID) >= 0) return [];

  const at = indexOf(def, UPDATE_STEP_ID);
  if (at < 0) {
    throw new Error(
      `No trunk step "${UPDATE_STEP_ID}" to wrap. The flow shape changed; re-read it before applying.`
    );
  }

  const original = def.steps[at];
  const auth = (original as { auth?: unknown }).auth;
  const urlVar = (original as { urlVar?: string }).urlVar;

  const arms = REACHED_ARMS.map((arm) => ({
    id: arm.id,
    label: `AI call ${arm.outcome}`,
    condition: { var: OUTCOME_VAR, equals: arm.outcome },
    steps: [
      {
        id: arm.stepId,
        type: "browse_action",
        urlVar,
        auth,
        actions: spokeActions(),
        screenshot: true
      }
    ]
  }));

  const gate: FlowStep = {
    id: GATE_STEP_ID,
    type: "branch",
    question: "Did this run actually reach the client by phone?",
    branches: arms,
    // The original step, unchanged and under its own id. A parked run resuming
    // at "re_update" still lands here.
    else: [original]
  } as unknown as FlowStep;

  def.steps.splice(at, 1, gate);
  return [GATE_STEP_ID, ...REACHED_ARMS.map((a) => a.stepId)];
}

/** Every step id in the definition, trunk and nested, for pre-flight printing. */
export function allStepIds(def: AiFlowDefinition): string[] {
  const out: string[] = [];
  const walk = (steps: readonly FlowStep[]): void => {
    for (const s of steps) {
      out.push(s.id);
      const b = s as unknown as {
        branches?: Array<{ steps?: FlowStep[] }>;
        else?: FlowStep[];
      };
      for (const arm of b.branches ?? []) walk(arm.steps ?? []);
      walk(b.else ?? []);
    }
  };
  walk(def.steps);
  return out;
}

/** Convenience for the applier and tests. */
export function buildHonestUpdate(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  added: string[];
} {
  const next = JSON.parse(JSON.stringify(live)) as AiFlowDefinition;
  return { definition: next, added: addUpdateHonestyGate(next) };
}
