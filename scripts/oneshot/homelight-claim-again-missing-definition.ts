/**
 * Pure builder: when HomeLight's post-claim page has no "Call me again"
 * button, do not dead-letter the run.
 *
 * INCIDENT, 2026-09-21. Natasha W. (San Tan Valley, AZ, ~$547K), two runs
 * `7ce0e9c3` and `06229aed`, ~15:36Z. `open` read `already_claimed=no`,
 * `claim_mode=call`. `claim_click` completed. `wait_hl_call` recorded
 * `no_call`. `claim_state` was "Other brokerage: another agent has it."
 * (the same overlay Debra M. taught us is often OUR claim). `recall_gate`
 * then tried `claim_again` (`click_text "Call me again"`). The button was
 * not on the page. `continueWhenText` is "We're calling you", which that
 * overlay also lacks, so the step failed terminal. Seller intro, the late
 * ladder, and the team offer never ran. HomeLight's `_ssgManifest.js` /
 * `_buildManifest.js` 404s in the same log line are the usual portal noise,
 * not the cause.
 *
 * Sep 11/14 died on the same brittle post-claim UI path (nav "Referrals",
 * then the abbreviated-name row click). Sep 15-16 recovered those with
 * selector waits and `continueWhenText: "We're calling you"`. That marker
 * only helps when the calling-you page is showing. This morning it was not.
 *
 * WHAT THIS CHANGES (no trunk add):
 *   - `claim_again.continueWhenMissingControl`: after the appear wait, a
 *     missing "Call me again" skips the step and the run carries on. The
 *     platform flag is the product fix; this one-shot opts Amy's step in.
 *   - `claim_again.missingControlSaveAs` = `claim_again_click`, written
 *     "missing" on that path.
 *   - `wait_hl_call2.when`: skip the second 6-minute wait when the click
 *     never happened (unset still waits: fail open).
 *   - `claim_again_miss` texts the team that HomeLight did not show the
 *     button, so they can tap it in the app if the seller still needs a
 *     call. Gated on `claim_again_click equals missing`.
 *
 * Unique step ids kept. Parked runs re-anchor by `__resume_step_id`.
 * `SHIFT_UNSAFE_RESUME_IDS` is empty: inserting the notify after
 * `claim_again` does not move wait2's id.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import { MISSING_CONTROL_VAR_VALUE } from "../../supabase/functions/_shared/ai_flows/page_markers";
import {
  CLAIM_AGAIN_ID,
  CLAIM_AGAIN_TARGET,
  RECALL_ARM_ID,
  RECALL_GATE_ID,
  WAIT2_ID
} from "./homelight-nocall-contact-definition";
import {
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

export type { Definition, Step };
export {
  CLAIM_AGAIN_ID,
  CLAIM_AGAIN_TARGET,
  RECALL_ARM_ID,
  RECALL_GATE_ID,
  WAIT2_ID
};

export const CLAIM_AGAIN_CLICK_VAR = "claim_again_click";
export const CLAIM_AGAIN_MISS_ID = "claim_again_miss";
export const WAIT2_WHEN = {
  var: CLAIM_AGAIN_CLICK_VAR,
  notEquals: MISSING_CONTROL_VAR_VALUE
} as const;
export const MISS_NOTIFY_WHEN = {
  var: CLAIM_AGAIN_CLICK_VAR,
  equals: MISSING_CONTROL_VAR_VALUE
} as const;

export const CLAIM_AGAIN_MISS_MESSAGE =
  "HomeLight did not show Call me again after the first claim call missed: " +
  "{{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}). " +
  "The run is still going (seller intro and the late contact ladder). " +
  "Check the HomeLight app if this seller still needs a call.\n" +
  "Claim status: {{vars.claim_state}}.\n" +
  "Portal: {{vars.leadUrl}}";

/**
 * No step ids move. Natasha's runs already failed terminal. Empty on purpose
 * so apply does not refuse an in-flight run parked on wait2 or claim_again.
 */
export const SHIFT_UNSAFE_RESUME_IDS = [] as const;

function requireStep(def: Definition, id: string, type?: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`no step "${id}"`);
  if (type && step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

function sameWhen(
  when: Step["when"] | undefined,
  expected: { var: string; equals?: string; notEquals?: string }
): boolean {
  if (!when) return false;
  return (
    when.var === expected.var &&
    when.equals === expected.equals &&
    when.notEquals === expected.notEquals
  );
}

function recallGoSteps(def: Definition): Step[] {
  const gate = requireStep(def, RECALL_GATE_ID, "branch");
  const arm = (gate.branches ?? []).find((b) => b.id === RECALL_ARM_ID);
  if (!arm || !Array.isArray(arm.steps)) {
    throw new Error(`no "${RECALL_ARM_ID}" arm on "${RECALL_GATE_ID}"`);
  }
  return arm.steps;
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];

  const again = requireStep(def, CLAIM_AGAIN_ID, "browse_action") as Step & {
    continueWhenMissingControl?: boolean;
    missingControlSaveAs?: string;
    actions?: Array<{ kind?: string; target?: string }>;
  };
  const click = Array.isArray(again.actions)
    ? again.actions.find((a) => a.kind === "click_text" && a.target === CLAIM_AGAIN_TARGET)
    : undefined;
  if (!click) {
    throw new Error(
      `"${CLAIM_AGAIN_ID}" does not click_text "${CLAIM_AGAIN_TARGET}"; ` +
        `actions=${JSON.stringify(again.actions)}`
    );
  }
  if (again.continueWhenMissingControl !== true) {
    again.continueWhenMissingControl = true;
    edits.push(`"${CLAIM_AGAIN_ID}": continueWhenMissingControl`);
  }
  if (again.missingControlSaveAs !== CLAIM_AGAIN_CLICK_VAR) {
    if (again.missingControlSaveAs) {
      throw new Error(
        `"${CLAIM_AGAIN_ID}".missingControlSaveAs is ${JSON.stringify(again.missingControlSaveAs)}, ` +
          `expected unset or "${CLAIM_AGAIN_CLICK_VAR}"`
      );
    }
    again.missingControlSaveAs = CLAIM_AGAIN_CLICK_VAR;
    edits.push(`"${CLAIM_AGAIN_ID}".missingControlSaveAs = ${CLAIM_AGAIN_CLICK_VAR}`);
  }

  const wait2 = requireStep(def, WAIT2_ID, "wait_for_call");
  if (!sameWhen(wait2.when, WAIT2_WHEN)) {
    if (wait2.when) {
      throw new Error(
        `"${WAIT2_ID}".when is ${JSON.stringify(wait2.when)}, expected unset or ${JSON.stringify(WAIT2_WHEN)}`
      );
    }
    wait2.when = { ...WAIT2_WHEN };
    edits.push(
      `"${WAIT2_ID}".when: skip the second wait when ${CLAIM_AGAIN_CLICK_VAR} is ${MISSING_CONTROL_VAR_VALUE}`
    );
  }

  if (!findStep(def, CLAIM_AGAIN_MISS_ID)) {
    const armSteps = recallGoSteps(def);
    const againAt = armSteps.findIndex((s) => s.id === CLAIM_AGAIN_ID);
    const waitAt = armSteps.findIndex((s) => s.id === WAIT2_ID);
    if (againAt < 0 || waitAt !== againAt + 1) {
      throw new Error(
        `"${RECALL_ARM_ID}" should be ... ${CLAIM_AGAIN_ID} then ${WAIT2_ID}, ` +
          `found ${armSteps.map((s) => s.id).join(" -> ")}`
      );
    }
    armSteps.splice(waitAt, 0, {
      id: CLAIM_AGAIN_MISS_ID,
      type: "notify_owner",
      message: CLAIM_AGAIN_MISS_MESSAGE,
      when: { ...MISS_NOTIFY_WHEN }
    });
    edits.push(`insert "${CLAIM_AGAIN_MISS_ID}" after "${CLAIM_AGAIN_ID}" (owner signal when the button is gone)`);
  }

  return edits;
}
