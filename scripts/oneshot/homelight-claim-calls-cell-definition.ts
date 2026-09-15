/**
 * Pure builder: when HomeLight's claim page will ring a teammate's cell,
 * do not wait on the AI DID, and do not let the post-click modal overwrite
 * "this referral is still ours".
 *
 * INCIDENT, 2026-09-15. Arletta L., Mesa AZ, ~$360K seller, run
 * `61550503-622a-46a3-97b4-9165ae03e949`. Inbound `hmlt.co` at 20:48Z.
 * `open` read `claim_mode=call`, `already_claimed=no`. The claim page said
 * it would call the number currently selected on Amy's HomeLight profile
 * (a cell, not +1 415 985 1909). `claim_click` completed. HomeLight then
 * showed "already claimed by another agent" (the same modal Amy saw later
 * in the iOS app). `card` re-extracted `already_claimed=yes` from that
 * overlay and overwrote open's `no`. Email later said Claimed By Amy
 * Laidlaw: our click registered. The voice flow never rang because
 * HomeLight called the cell, not the AI DID. `wait_hl_call` still sat on
 * +1 415 985 1909. `claim_again` never clicked: `continueWhenText:
 * "HomeLight"` matches the referrals-list header, so a miss counted as
 * already satisfied. `lost_branch` then skipped `save_contact` /
 * `lead_sms` / `late2_portal_sms`. The team still got the contact at the
 * unclaimed-email ladder (~22:07Z). Press-1 is the other path (warm
 * transfer IVR, `is_warm_transfer`). This SMS referral is `digital_call`.
 *
 * HomeLight's claim-page Edit control is a mobile/office picker, not a
 * freeform DID field. The AI number can be selected only if it is already
 * saved as Office on the HomeLight profile. This patch does not click Edit.
 *
 * WHAT THIS CHANGES (no net trunk add):
 *   - `open` gains `claim_callback_is_ai` (yes/no). yes if the selected
 *     callback is 415 985 1909, or if the model cannot tell (keeps the
 *     wait path for in-flight runs that never extracted the field).
 *   - Nest the call arm behind `callback_gate`. Arm on
 *     `claim_callback_is_ai equals no`: `cell_ring_alert` (pick up the
 *     claim-page phone; coworker already clicked Claim). Else: the existing
 *     brief / wait / recall / route / no_call_msg. Empty var fails
 *     `equals no`, so a skipped extract still waits. Do not put
 *     `when` on `route`: empty `hl_call_outcome` PASSES
 *     `notEquals no_call`.
 *   - Drop `already_claimed` from `card` so the post-click modal cannot
 *     overwrite open's pre-click read. `lost_branch` still keys on that
 *     var.
 *   - `claim_again.continueWhenText` "HomeLight" -> "We're calling you"
 *     (the post-click success page). The old marker is on every HomeLight
 *     header, including the referrals list after a miss.
 *
 * Unique step ids kept. `when` stays one condition on one var.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import {
  BRIEF_ID,
  NO_CALL_MSG_ID,
  OFFER_CALL_ARM_ID,
  OFFER_GATE_ID,
  WAIT_ID
} from "./homelight-claim-then-offer-definition";
import {
  CLAIM_AGAIN_CONTINUE,
  CLAIM_AGAIN_ID
} from "./homelight-nocall-contact-definition";
import {
  CARD_ID,
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

export type { Definition, Step };

export const OPEN_ID = "open";
export const CALLBACK_GATE_ID = "callback_gate";
export const CALLBACK_CELL_ARM_ID = "callback_cell";
export const CELL_ALERT_ID = "cell_ring_alert";
export const CALLBACK_VAR = "claim_callback_is_ai";
export const ALREADY_CLAIMED_VAR = "already_claimed";
/** The AI coworker's HomeLight DID, already in the wait_for_call fromE164. */
export const AI_DID_DISPLAY = "415 985 1909";
export const CLAIM_AGAIN_CONTINUE_NEW = "We're calling you";

export const CALLBACK_CELL_WHEN = { var: CALLBACK_VAR, equals: "no" } as const;

/**
 * Schema caps extraction field descriptions at 300 chars. Default to yes
 * when unsure so in-flight runs and ambiguous pages still wait on the DID.
 */
export const CALLBACK_FIELD = {
  name: CALLBACK_VAR,
  description:
    `Is the selected claim-callback the AI coworker's HomeLight number (${AI_DID_DISPLAY})? ` +
    "Answer yes if the page will call that number, or if you cannot tell. " +
    "Answer no only if it shows a different phone (for example a cell labeled as the agent's). " +
    "One lowercase word."
};

export const CELL_ALERT_MESSAGE =
  "HomeLight is ringing the phone currently selected on the claim page for " +
  "{{vars.lead_first_name}} ({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}). " +
  "The coworker already clicked Claim. Pick that phone up now to accept the referral. " +
  "This is not a live transfer, and it is not a call to the AI coworker's number, " +
  "so the AI cannot take it.\n" +
  "Claim status: {{vars.claim_state}}.\n" +
  "Portal: {{vars.leadUrl}}";

export const SHIFT_UNSAFE_RESUME_IDS = [
  CALLBACK_GATE_ID,
  CELL_ALERT_ID,
  CLAIM_AGAIN_ID,
  BRIEF_ID,
  WAIT_ID
] as const;

function cloneStep<T>(step: T): T {
  return JSON.parse(JSON.stringify(step)) as T;
}

function requireStep(def: Definition, id: string, type?: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`no step "${id}"`);
  if (type && step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

function callArm(def: Definition): { id?: string; steps?: Step[] } {
  const gate = requireStep(def, OFFER_GATE_ID, "branch");
  const arm = (gate.branches ?? []).find((b) => b.id === OFFER_CALL_ARM_ID);
  if (!arm || !Array.isArray(arm.steps)) {
    throw new Error(`no "${OFFER_CALL_ARM_ID}" arm`);
  }
  return arm as { id?: string; steps?: Step[] };
}

function addCallbackField(def: Definition, edits: string[]): void {
  const open = requireStep(def, OPEN_ID, "browse_extract");
  const fields = Array.isArray(open.fields) ? open.fields : [];
  if (fields.some((f) => f?.name === CALLBACK_VAR)) return;
  if (!fields.some((f) => f?.name === "claim_mode")) {
    throw new Error(`"${OPEN_ID}" is missing claim_mode; not the HomeLight Referral flow`);
  }
  open.fields = [...fields, { ...CALLBACK_FIELD }];
  edits.push(`add "${CALLBACK_VAR}" to "${OPEN_ID}"`);
}

function wrapCallArm(def: Definition, edits: string[]): void {
  if (findStep(def, CALLBACK_GATE_ID)) return;
  const arm = callArm(def);
  const existing = (arm.steps ?? []).slice();
  if (existing[0]?.id !== BRIEF_ID || existing[1]?.id !== WAIT_ID) {
    throw new Error(
      `"${OFFER_CALL_ARM_ID}" should start with ${BRIEF_ID}, ${WAIT_ID}; found ${existing
        .map((s) => s.id)
        .join(",")}`
    );
  }
  if (!findStep(def, CLAIM_AGAIN_ID)) {
    throw new Error(`no step "${CLAIM_AGAIN_ID}"; apply homelight-nocall-contact first`);
  }
  const noCall = requireStep(def, NO_CALL_MSG_ID, "notify_lead_owner");
  const alert = cloneStep(noCall);
  alert.id = CELL_ALERT_ID;
  alert.message = CELL_ALERT_MESSAGE;
  delete alert.when;
  arm.steps = [
    {
      id: CALLBACK_GATE_ID,
      type: "branch",
      question: "Is HomeLight going to call the AI coworker's number, or a teammate's cell?",
      branches: [
        {
          id: CALLBACK_CELL_ARM_ID,
          label: "HomeLight will ring a teammate's phone: tell them to pick up",
          condition: { ...CALLBACK_CELL_WHEN },
          steps: [alert]
        }
      ],
      else: existing
    }
  ];
  edits.push(
    `wrap call arm in "${CALLBACK_GATE_ID}" (wait only when the callback is the AI DID)`
  );
}

function dropCardAlreadyClaimed(def: Definition, edits: string[]): void {
  const card = requireStep(def, CARD_ID, "browse_extract");
  const fields = Array.isArray(card.fields) ? card.fields : [];
  const next = fields.filter((f) => f?.name !== ALREADY_CLAIMED_VAR);
  if (next.length === fields.length) return;
  if (next.length < 4) {
    throw new Error(`"${CARD_ID}" would lose contact fields after dropping ${ALREADY_CLAIMED_VAR}`);
  }
  card.fields = next;
  edits.push(`drop "${ALREADY_CLAIMED_VAR}" from "${CARD_ID}" (keep open's pre-click read)`);
}

function retargetClaimAgain(def: Definition, edits: string[]): void {
  const step = requireStep(def, CLAIM_AGAIN_ID, "browse_action") as Step & {
    continueWhenText?: string;
  };
  if (step.continueWhenText === CLAIM_AGAIN_CONTINUE_NEW) return;
  if (step.continueWhenText !== CLAIM_AGAIN_CONTINUE) {
    throw new Error(
      `"${CLAIM_AGAIN_ID}".continueWhenText is ${JSON.stringify(step.continueWhenText)}, ` +
        `expected "${CLAIM_AGAIN_CONTINUE}" or "${CLAIM_AGAIN_CONTINUE_NEW}"`
    );
  }
  step.continueWhenText = CLAIM_AGAIN_CONTINUE_NEW;
  edits.push(
    `"${CLAIM_AGAIN_ID}".continueWhenText: "${CLAIM_AGAIN_CONTINUE}" -> "${CLAIM_AGAIN_CONTINUE_NEW}"`
  );
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];
  addCallbackField(def, edits);
  wrapCallArm(def, edits);
  dropCardAlreadyClaimed(def, edits);
  retargetClaimAgain(def, edits);
  return edits;
}
