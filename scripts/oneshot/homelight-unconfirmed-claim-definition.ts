/**
 * Pure builder: a HomeLight claim page that still shows "Call me to claim
 * referral" is not a claim, no matter what the model says.
 *
 * INCIDENT, 2026-09-23. Ron G. (Mesa, AZ, ~$625K), run e7c5e9b3. claim_click
 * reported success. Every later screenshot was the same unclaimed page, with
 * the orange button still reading "Call me to claim referral" and the
 * callback line "We will call you at Amy's Cell (602) 805-3377". claim_verify
 * answered "Call me again", which is an example of a SUCCESSFUL claim in the
 * field prompt, not a phrase on that page. The retry arm only fires when
 * claim_state contains "NOT CONFIRMED", so it never ran. The team was told
 * "HomeLight claimed this referral but the seller was not on the call."
 * HomeLight's 90-minute email then told Amy the referral was getting cold.
 *
 * WHAT THIS CHANGES (no trunk add):
 *   - claim_verify and claim_verify2 gain forceWhenText: if the page still
 *     contains "Call me to claim referral", claim_state is forced to
 *     "NOT CONFIRMED, claim by hand now". The existing claim_fix retry then
 *     clicks the button again.
 *   - offer_gate gains a first arm on claim_state contains "NOT CONFIRMED".
 *     That arm alerts the team to tap the button. It does not wait for a
 *     call and it does not say the referral was claimed. First-match, so it
 *     wins over the call arm. An empty claim_state does not match and keeps
 *     today's path.
 *   - lead_phone field descriptions say: if the only number is the
 *     "We will call you at" callback, answer none. A swallowed click then
 *     does not look like the lead's phone matched the business line.
 *
 * Unique step ids kept. Parked runs re-anchor by __resume_step_id.
 * SHIFT_UNSAFE_RESUME_IDS is empty: the new arm is nested, and no existing
 * step id moves.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

import { STATE_UNCONFIRMED } from "./homelight-verified-claim";
import { OFFER_GATE_ID } from "./homelight-claim-then-offer-definition";
import {
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

export type { Definition, Step };

export const UNCONFIRMED_BUTTON = "Call me to claim referral";
export const VERIFY_IDS = ["claim_verify", "claim_verify2"] as const;
export const UNCONFIRMED_ARM_ID = "offer_unconfirmed";
export const UNCONFIRMED_ALERT_ID = "unconfirmed_alert";
export const UNCONFIRMED_WHEN = { var: "claim_state", contains: "NOT CONFIRMED" } as const;

export const CALLBACK_PHONE_NOTE =
  " If the only number is We will call you at, answer none.";

export const UNCONFIRMED_ALERT_MESSAGE =
  "HomeLight's claim click did not register: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}). " +
  "The page still shows Call me to claim referral. Open the portal and tap that button. This is not a claim.\n" +
  "Portal: {{vars.leadUrl}}";

/** No existing step id moves. */
export const SHIFT_UNSAFE_RESUME_IDS = [] as const;

const FIELD_DESC_MAX = 300;

type ExtractField = { name?: string; description?: string };

function requireStep(def: Definition, id: string, type?: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`no step "${id}"`);
  if (type && step.type !== type) {
    throw new Error(`step "${id}" is a ${String(step.type)}, not a ${type}`);
  }
  return step;
}

function sameForce(step: Step): boolean {
  const rules = step.forceWhenText as Array<{ contains?: string; set?: Record<string, string> }> | undefined;
  if (!Array.isArray(rules) || rules.length !== 1) return false;
  const rule = rules[0];
  return (
    rule?.contains === UNCONFIRMED_BUTTON &&
    rule.set?.claim_state === STATE_UNCONFIRMED
  );
}

function walk(steps: unknown, visit: (step: Step) => void): void {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    if (!step || typeof step !== "object") continue;
    visit(step);
    for (const arm of Array.isArray(step.branches) ? step.branches : []) {
      walk(arm?.steps, visit);
    }
    walk(step.else, visit);
  }
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];

  for (const id of VERIFY_IDS) {
    const step = requireStep(def, id, "browse_extract");
    if (!sameForce(step)) {
      if (step.forceWhenText) {
        throw new Error(
          `"${id}".forceWhenText is ${JSON.stringify(step.forceWhenText)}, expected unset or the unclaimed-button rule`
        );
      }
      step.forceWhenText = [
        { contains: UNCONFIRMED_BUTTON, set: { claim_state: STATE_UNCONFIRMED } }
      ];
      edits.push(
        `"${id}": page still showing "${UNCONFIRMED_BUTTON}" forces claim_state to NOT CONFIRMED`
      );
    }
  }

  const gate = requireStep(def, OFFER_GATE_ID, "branch");
  const arms = gate.branches ?? [];
  if (!arms.some((arm) => arm.id === UNCONFIRMED_ARM_ID)) {
    if (arms.length >= 4) {
      throw new Error(`${OFFER_GATE_ID} already has ${arms.length} arms; the schema cap is 4`);
    }
    arms.unshift({
      id: UNCONFIRMED_ARM_ID,
      label: "Claim click did not register: the original button is still on the page",
      condition: { ...UNCONFIRMED_WHEN },
      steps: [
        {
          id: UNCONFIRMED_ALERT_ID,
          type: "notify_owner",
          message: UNCONFIRMED_ALERT_MESSAGE
        }
      ]
    });
    gate.branches = arms;
    edits.push(
      `insert "${UNCONFIRMED_ARM_ID}" first on "${OFFER_GATE_ID}" (do not wait or say we claimed it)`
    );
  }

  walk(def.steps, (step) => {
    if (step.type !== "browse_extract" || !Array.isArray(step.fields)) return;
    for (const field of step.fields as ExtractField[]) {
      if (field.name !== "lead_phone") continue;
      const description = field.description ?? "";
      if (description.includes("We will call you at")) continue;
      const next = `${description}${CALLBACK_PHONE_NOTE}`;
      if (next.length > FIELD_DESC_MAX) {
        throw new Error(
          `lead_phone description on "${String(step.id)}" is ${description.length} chars; ` +
            `adding the callback note would exceed ${FIELD_DESC_MAX}`
        );
      }
      field.description = next;
      edits.push(`"${String(step.id)}".lead_phone: the callback line is not the seller`);
    }
  });

  return edits;
}
