/**
 * Pure builder: do not tell the team a HomeLight referral went to another
 * agent when WE just claimed it, and do not MMS the post-click overlay.
 *
 * INCIDENT, 2026-09-16, Debra M. (Mesa AZ, ~$227K), run
 * `aaeb08fb-3447-4fad-a81a-947c2ce53bfb`. `open` read `already_claimed=no`,
 * `claim_mode=call`. `claim_click` completed. HomeLight then showed
 * "already claimed by another agent" (the same modal Amy sees in the iOS
 * app after she taps Claim). That click registered: wait attached, the
 * inbound answered, contact later landed, and email would have said
 * Claimed By Amy Laidlaw. `claim_verify` still wrote
 * `claim_state=another agent has it` because the field treated that dialog
 * as a rival. `card` then published `screenshot: true` of the overlay,
 * overwriting `open`'s claim page, and `route.attachScreenshot` MMSed it
 * onto the team offer and the "still unclaimed" reminders. The group
 * thought we lost the lead. We had it.
 *
 * Vince N. already taught `claim_state` that Claimed By Amy Laidlaw is
 * ours. This dialog has no Claimed By row. Arletta L. already dropped
 * `already_claimed` from `card` so the overlay cannot skip seller intro.
 * The screenshot and the copy were the remaining hole.
 *
 * WHAT THIS CHANGES (no trunk add, no moved step ids):
 *   - `claim_verify` / `claim_verify2` `claim_state`: the already-claimed
 *     dialog after our Claim click is `claim message sent`. A Claimed By
 *     row naming a different brokerage is still `another agent has it`.
 *   - `card` and `claim_again` stop publishing `screenshot_path`, so the
 *     overlay cannot replace `open`'s shot.
 *   - `route` and `route_text` stop attaching that shot as MMS. The only
 *     screenshot that should go to the team is the contact card, which
 *     `final_read` / `late2_portal` still capture and `qt_email` attaches
 *     once details exist.
 *
 * Unique step ids kept. Parked runs re-anchor by `__resume_step_id`.
 *
 * Pure: no I/O. The applier reads, validates, writes, and records the ledger.
 */

export {
  CARD_ID,
  VERIFY_ID,
  VERIFY2_ID,
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

import { CLAIM_STATE_FIELD } from "./homelight-verified-claim";
import {
  ROUTE_ID,
  ROUTE_TEXT_ID
} from "./homelight-claim-then-offer-definition";
import { CLAIM_AGAIN_ID } from "./homelight-nocall-contact-definition";
import {
  CARD_ID,
  VERIFY_ID,
  VERIFY2_ID,
  findStep,
  type Definition,
  type Step
} from "./homelight-text-claim-details-definition";

export const VERIFY_CLAIMED_WHEN = { var: "claim_mode", notEquals: "none" } as const;

/**
 * No step ids move. Debra's run was parked on `bp_wait`; that resume is
 * safe. Empty on purpose so apply does not refuse the in-flight run.
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

function sameClaimState(fields: Step["fields"]): boolean {
  const f = Array.isArray(fields) && fields.length === 1 ? fields[0] : null;
  return f?.name === CLAIM_STATE_FIELD.name && f.description === CLAIM_STATE_FIELD.description;
}

function dropPublishedScreenshot(step: Step, id: string, edits: string[]): void {
  if (step.screenshot !== true) return;
  delete step.screenshot;
  edits.push(`"${id}" stops publishing screenshot_path (do not MMS the overlay)`);
}

function dropAttachScreenshot(step: Step, id: string, edits: string[]): void {
  if (step.attachScreenshot !== true) return;
  delete step.attachScreenshot;
  edits.push(`"${id}" stops attaching a screenshot (contact card only, via qt_email)`);
}

export function patchDefinition(def: Definition): string[] {
  const edits: string[] = [];

  for (const id of [VERIFY_ID, VERIFY2_ID]) {
    const step = requireStep(def, id, "browse_extract");
    if (!sameClaimState(step.fields)) {
      step.fields = [{ ...CLAIM_STATE_FIELD }];
      edits.push(`"${id}".claim_state: already-claimed dialog after we clicked is ours`);
    }
  }

  const verify = requireStep(def, VERIFY_ID, "browse_extract");
  const when = verify.when as { var?: string; notEquals?: string } | undefined;
  if (when?.var !== VERIFY_CLAIMED_WHEN.var || when.notEquals !== VERIFY_CLAIMED_WHEN.notEquals) {
    verify.when = { ...VERIFY_CLAIMED_WHEN };
    edits.push(`"${VERIFY_ID}" only runs when we had a Call or Send button`);
  }

  dropPublishedScreenshot(requireStep(def, CARD_ID, "browse_extract"), CARD_ID, edits);
  dropPublishedScreenshot(requireStep(def, CLAIM_AGAIN_ID, "browse_action"), CLAIM_AGAIN_ID, edits);
  dropAttachScreenshot(requireStep(def, ROUTE_ID, "route_to_team"), ROUTE_ID, edits);
  dropAttachScreenshot(requireStep(def, ROUTE_TEXT_ID, "route_to_team"), ROUTE_TEXT_ID, edits);

  const finalRead = requireStep(def, "final_read", "browse_extract");
  if (finalRead.screenshot !== true) {
    throw new Error(`"final_read" must keep screenshot:true so qt_email can attach the contact card`);
  }
  const qt = requireStep(def, "qt_email", "send_email");
  if (qt.attachScreenshot !== true) {
    throw new Error(`"qt_email" must keep attachScreenshot so the contact card still goes out`);
  }

  return edits;
}
