/**
 * Pure builder: when HomeLight's claim call never arrives, retry the claim,
 * text the seller as soon as we have a number, and stop the last-step portal
 * note from failing runs nobody roster-claimed.
 *
 * INCIDENT, 2026-09-14. Amy's iPhone showed HomeLight's own 30-minute nags
 * ("Respond to your referral") for Sharon I. (San Tan Valley, ~$391K, run
 * `89268fa7`) and Brandi V. (Vaccaro, ~$300K, run `62ecd626`). Both were
 * call-mode. `claim_click` completed. `claim_state` was "Call me again" /
 * "We're calling you". `wait_hl_call` recorded `no_call`. Nobody pressed 1
 * (`claimed_agent=none`). `lead_sms` is gated on that roster claim, so the
 * seller intro never went out at the first mailbox read. `late2_wait` then
 * slept 60 minutes. Sharon's details email landed in that window and we
 * texted at ~86 minutes. Brandi's mailbox and portal never produced a phone
 * (`lead_phone=""`), so nothing went to the seller. HomeLight kept nagging
 * Amy. She claimed in the app by hand, which is when the contact card showed
 * up in her inbox, then called the AI number herself. A picture of that card
 * sent to the coworker cannot write AiFlow vars.
 *
 * `homelight-claim-then-offer` also retargeted `hl_portal_note` from
 * `claimed_agent notEquals none` to `claim_mode notEquals none`, so every
 * finished no-call run tried the flaky name click and died at the last
 * nested step (Vince, Sharon, both Brandi runs). The lead work was already
 * done. Restore the roster gate.
 *
 * WHAT THIS CHANGES (no net trunk add):
 *   - After `wait_hl_call` returns `no_call`, pause 1 minute, click
 *     "Call me again" (the button HomeLight shows after a verified call
 *     claim; the original "Call me to claim referral" is gone), and wait
 *     a second time. A connected second wait still offers the team.
 *   - `lead_sms` / `lead_email` fire when `contact_status equals found`, not
 *     when a teammate pressed 1. The late ladder already texts on a found
 *     mailbox read; the first read was skipping the seller.
 *   - `late2_wait` 60 minutes -> 15, so the second mailbox look is inside
 *     HomeLight's nag window rather than an hour past it.
 *   - When `late2_portal` finds a phone after the mailbox miss, text and
 *     email the seller (empty phone still only alerts).
 *   - `hl_portal_note.when` back to `claimed_agent notEquals none`.
 *
 * Unique step ids kept. `when` stays one condition on one var.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import {
  ROUTE_ID,
  WAIT_ID,
  offerCallWorkSteps
} from "./homelight-claim-then-offer-definition";
import {
  PORTAL_ALERT_ID,
  PHONE_MISS_ID,
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

export type { Definition, Step };

export const RECALL_GATE_ID = "recall_gate";
export const RECALL_ARM_ID = "recall_go";
export const RECALL_PAUSE_ID = "recall_pause";
export const CLAIM_AGAIN_ID = "claim_again";
export const WAIT2_ID = "wait_hl_call2";
export const PORTAL_SMS_ID = "late2_portal_sms";
export const PORTAL_EMAIL_ID = "late2_portal_email";
export const NOTE_ID = "hl_portal_note";
export const LEAD_SMS_ID = "lead_sms";
export const LEAD_EMAIL_ID = "lead_email";
export const LATE2_WAIT_ID = "late2_wait";
export const CLAIM_RETRY_ID = "claim_retry";
export const CLAIM_AGAIN_TARGET = "Call me again";
export const ORIGINAL_CLAIM_TARGET = "Call me to claim referral";
export const CLAIM_AGAIN_CONTINUE = "HomeLight";

export const LATE2_WAIT_MINUTES = 15;
export const RECALL_PAUSE_MINUTES = 1;

export const CONTACT_FOUND_WHEN = { var: "contact_status", equals: "found" } as const;
export const ROSTER_CLAIM_WHEN = { var: "claimed_agent", notEquals: "none" } as const;
export const NOTE_CLAIM_MODE_WHEN = { var: "claim_mode", notEquals: "none" } as const;

export const SHIFT_UNSAFE_RESUME_IDS = [
  RECALL_GATE_ID,
  RECALL_PAUSE_ID,
  CLAIM_AGAIN_ID,
  WAIT2_ID,
  LATE2_WAIT_ID,
  PORTAL_SMS_ID,
  PORTAL_EMAIL_ID
] as const;

function cloneStep<T>(step: T): T {
  return JSON.parse(JSON.stringify(step)) as T;
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

function offerCallSteps(def: Definition): Step[] {
  return offerCallWorkSteps(def) as Step[];
}

function requireStep(def: Definition, id: string, type: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`no step "${id}"`);
  if (step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

function retargetContactFound(def: Definition, id: string, edits: string[]): void {
  const step = requireStep(def, id, id === LEAD_SMS_ID ? "send_sms" : "send_email");
  if (sameWhen(step.when, CONTACT_FOUND_WHEN)) return;
  if (!sameWhen(step.when, ROSTER_CLAIM_WHEN)) {
    throw new Error(`"${id}".when is ${JSON.stringify(step.when)}, expected claimed_agent notEquals none`);
  }
  step.when = { ...CONTACT_FOUND_WHEN };
  edits.push(`"${id}".when: claimed_agent notEquals none -> contact_status equals found`);
}

function cloneLeadSend(def: Definition, fromId: string, toId: string, when: Step["when"]): Step {
  const src = findStep(def, fromId);
  if (!src) throw new Error(`no step "${fromId}" to clone`);
  const copy = cloneStep(src);
  copy.id = toId;
  copy.when = when;
  return copy;
}

function recallGate(def: Definition): Step {
  const wait = requireStep(def, WAIT_ID, "wait_for_call");
  const retry = requireStep(def, CLAIM_RETRY_ID, "browse_action");
  const wait2 = cloneStep(wait);
  wait2.id = WAIT2_ID;
  delete wait2.when;
  const claimAgain: Step = {
    id: CLAIM_AGAIN_ID,
    type: "browse_action",
    ...(retry.auth ? { auth: retry.auth } : {}),
    urlVar: retry.urlVar,
    screenshot: true,
    continueWhenText: CLAIM_AGAIN_CONTINUE,
    actions: [{ kind: "click_text", target: CLAIM_AGAIN_TARGET }]
  };
  return {
    id: RECALL_GATE_ID,
    type: "branch",
    question: "Did HomeLight's claim call miss our line? Click Call me again.",
    branches: [
      {
        id: RECALL_ARM_ID,
        label: "No call came in: retry the claim and wait again",
        condition: { var: "hl_call_outcome", equals: "no_call" },
        steps: [
          {
            id: RECALL_PAUSE_ID,
            type: "sleep",
            minutes: RECALL_PAUSE_MINUTES
          },
          claimAgain,
          wait2
        ]
      }
    ],
    else: []
  };
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];

  const callSteps = offerCallSteps(def);
  const waitAt = callSteps.findIndex((s) => s.id === WAIT_ID);
  if (waitAt < 0) throw new Error(`"${WAIT_ID}" is not in the call arm`);
  if (!findStep(def, RECALL_GATE_ID)) {
    const next = callSteps[waitAt + 1];
    if (!next || next.id !== ROUTE_ID) {
      throw new Error(
        `"${WAIT_ID}" should sit immediately before "${ROUTE_ID}" on the call arm, found ${String(next?.id)}`
      );
    }
    callSteps.splice(waitAt + 1, 0, recallGate(def));
    edits.push(
      `insert "${RECALL_GATE_ID}" after "${WAIT_ID}" (retry Claim when the first wait is no_call)`
    );
  }

  retargetContactFound(def, LEAD_SMS_ID, edits);
  retargetContactFound(def, LEAD_EMAIL_ID, edits);

  const late2Wait = requireStep(def, LATE2_WAIT_ID, "sleep") as Step & { minutes?: number };
  if (late2Wait.minutes !== LATE2_WAIT_MINUTES) {
    if (late2Wait.minutes !== 60) {
      throw new Error(
        `"${LATE2_WAIT_ID}".minutes is ${String(late2Wait.minutes)}, expected 60 or ${LATE2_WAIT_MINUTES}`
      );
    }
    late2Wait.minutes = LATE2_WAIT_MINUTES;
    edits.push(`"${LATE2_WAIT_ID}": 60 minutes -> ${LATE2_WAIT_MINUTES}`);
  }

  const miss = findStep(def, PHONE_MISS_ID);
  if (!miss) throw new Error(`no step "${PHONE_MISS_ID}"`);
  if (!Array.isArray(miss.else)) throw new Error(`"${PHONE_MISS_ID}" has no else arm`);
  if (!findStep(def, PORTAL_SMS_ID)) {
    const alertAt = miss.else.findIndex((s) => s.id === PORTAL_ALERT_ID);
    if (alertAt < 0) throw new Error(`"${PORTAL_ALERT_ID}" is not the portal-found else`);
    miss.else.splice(
      alertAt,
      0,
      cloneLeadSend(def, LEAD_SMS_ID, PORTAL_SMS_ID, {
        var: "lead_phone",
        contains: "+"
      }),
      cloneLeadSend(def, LEAD_EMAIL_ID, PORTAL_EMAIL_ID, {
        var: "lead_email",
        contains: "@"
      })
    );
    edits.push(`insert "${PORTAL_SMS_ID}" / "${PORTAL_EMAIL_ID}" when the portal card had a phone`);
  }

  const note = requireStep(def, NOTE_ID, "browse_action");
  if (!sameWhen(note.when, ROSTER_CLAIM_WHEN)) {
    if (!sameWhen(note.when, NOTE_CLAIM_MODE_WHEN)) {
      throw new Error(
        `"${NOTE_ID}".when is ${JSON.stringify(note.when)}, expected claim_mode notEquals none`
      );
    }
    note.when = { ...ROSTER_CLAIM_WHEN };
    edits.push(`"${NOTE_ID}".when: claim_mode notEquals none -> claimed_agent notEquals none`);
  }

  return edits;
}
