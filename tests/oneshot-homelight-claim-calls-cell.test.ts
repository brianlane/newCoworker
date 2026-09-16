import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { patchDefinition as patchTextClaimDetails } from "../scripts/oneshot/homelight-text-claim-details-definition";
import { patchDefinition as patchNocall } from "../scripts/oneshot/homelight-nocall-contact-definition";
import {
  BRIEF_ID,
  NO_CALL_MSG_ID,
  NOTIFY_UNCLAIMED_ID,
  OFFER_CALL_ARM_ID,
  OFFER_GATE_ID,
  ROUTE_ID,
  UNCLAIMED_NOT_NOCALL_ID,
  WAIT_ID
} from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { CARD_ID, findStep, type Definition } from "../scripts/oneshot/homelight-text-claim-details-definition";
import {
  CLAIM_AGAIN_CONTINUE,
  CLAIM_AGAIN_ID,
  RECALL_ARM_ID,
  RECALL_GATE_ID,
  WAIT2_ID
} from "../scripts/oneshot/homelight-nocall-contact-definition";
import {
  AI_DID_DISPLAY,
  ALREADY_CLAIMED_VAR,
  CALLBACK_CELL_ARM_ID,
  CALLBACK_CELL_WHEN,
  CALLBACK_FIELD,
  CALLBACK_GATE_ID,
  CALLBACK_VAR,
  CELL_ALERT_ID,
  CELL_ALERT_MESSAGE,
  CLAIM_AGAIN_CONTINUE_NEW,
  CLAIM_MODE_NOT_CALL_WHEN,
  CALLBACK_NOT_CELL_WHEN,
  OPEN_ID,
  SHIFT_UNSAFE_RESUME_IDS,
  UNCLAIMED_AI_CALLBACK_ARM_ID,
  UNCLAIMED_CELL_SKIP_ID,
  UNCLAIMED_TEXT_ARM_ID,
  NOTIFY_UNCLAIMED_AI_ID,
  callbackField,
  formatAiDidDisplay,
  patchDefinition
} from "../scripts/oneshot/homelight-claim-calls-cell-definition";
import {
  BRANCH_ELSE_ARM,
  branchChoiceVar,
  flattenSteps,
  isOnActivePath
} from "../supabase/functions/_shared/ai_flows/branching";

/**
 * homelight-claim-calls-cell.ts.
 *
 * 2026-09-15: Arletta L. (Mesa AZ, ~$360K, run 61550503). Call-mode, the
 * claim page selected a teammate cell not the AI DID 602 805 3377, claim_click
 * completed, card overwrote already_claimed from the post-click modal,
 * wait sat on HomeLight's FROM (415), claim_again treated a referrals-list miss as
 * success.
 */

type Step = Record<string, any>;

function liveDefinition(): Definition {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "homelight-referral-live-2026-09-13.json"), "utf8")
  ) as Definition;
}

function patchedLive(): Definition {
  const def = liveDefinition();
  patchClaimThenOffer(def);
  patchTextClaimDetails(def);
  patchNocall(def);
  patchDefinition(def);
  return def;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  expect(step, `step "${id}"`).toBeTruthy();
  return step as Step;
}

describe("homelight-claim-calls-cell", () => {
  it("patches the post-nocall snapshot into a valid definition", () => {
    const def = liveDefinition();
    patchClaimThenOffer(def);
    patchTextClaimDetails(def);
    patchNocall(def);
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = patchedLive();
    expect(patchDefinition(def)).toEqual([]);
  });

  it("does not break a later re-run of claim-then-offer or nocall-contact", () => {
    const def = patchedLive();
    expect(patchClaimThenOffer(def)).toEqual([]);
    expect(patchNocall(def)).toEqual([]);
  });

  it("extracts whether the selected callback is the AI DID, under the 300-char cap", () => {
    const def = patchedLive();
    const open = byId(def, OPEN_ID);
    const field = open.fields.find((f: { name?: string }) => f.name === CALLBACK_VAR);
    expect(field).toEqual(CALLBACK_FIELD);
    expect(CALLBACK_FIELD.description.length).toBeLessThanOrEqual(300);
    expect(CALLBACK_FIELD.description).toContain(AI_DID_DISPLAY);
    expect(CALLBACK_FIELD.description).not.toContain("415");
    expect(CALLBACK_FIELD.description).toMatch(/Send message/i);
    expect(CALLBACK_FIELD.description.toLowerCase()).not.toContain("receptionist");
    expect(CALLBACK_FIELD.description).not.toMatch(/\u2014/);
  });

  it("waits on the AI DID only when the callback is not a teammate cell", () => {
    const def = patchedLive();
    const gate = byId(def, OFFER_GATE_ID);
    const callArm = gate.branches.find((b: Step) => b.id === OFFER_CALL_ARM_ID);
    expect(callArm.steps.map((s: Step) => s.id)).toEqual([CALLBACK_GATE_ID]);
    const callback = byId(def, CALLBACK_GATE_ID);
    expect(callback.type).toBe("branch");
    expect(callback.branches).toHaveLength(1);
    expect(callback.branches[0].id).toBe(CALLBACK_CELL_ARM_ID);
    expect(callback.branches[0].condition).toEqual(CALLBACK_CELL_WHEN);
    expect(callback.branches[0].steps.map((s: Step) => s.id)).toEqual([CELL_ALERT_ID]);
    expect(callback.else.map((s: Step) => s.id)).toEqual([
      BRIEF_ID,
      WAIT_ID,
      RECALL_GATE_ID,
      ROUTE_ID,
      NO_CALL_MSG_ID
    ]);
    expect(evaluateStepCondition(CALLBACK_CELL_WHEN, { vars: { [CALLBACK_VAR]: "no" } })).toBe(
      true
    );
    expect(evaluateStepCondition(CALLBACK_CELL_WHEN, { vars: { [CALLBACK_VAR]: "yes" } })).toBe(
      false
    );
    expect(evaluateStepCondition(CALLBACK_CELL_WHEN, { vars: {} })).toBe(false);
    const alert = byId(def, CELL_ALERT_ID);
    expect(alert.type).toBe("notify_lead_owner");
    expect(alert.message).toBe(CELL_ALERT_MESSAGE);
    expect(alert.when).toBeUndefined();
    expect(alert.unownedFallback).toBe("team");
    expect(alert.message).not.toMatch(/reply\s*1/i);
    expect(byId(def, ROUTE_ID).when).toEqual({
      var: "hl_call_outcome",
      notEquals: "no_call"
    });
  });

  it("does not let the post-click modal overwrite already_claimed", () => {
    const def = patchedLive();
    const cardNames = byId(def, CARD_ID).fields.map((f: { name?: string }) => f.name);
    expect(cardNames).not.toContain(ALREADY_CLAIMED_VAR);
    expect(byId(def, OPEN_ID).fields.some((f: { name?: string }) => f.name === ALREADY_CLAIMED_VAR)).toBe(
      true
    );
  });

  it("treats Call me again as done only on the calling-you page", () => {
    const def = patchedLive();
    expect(byId(def, CLAIM_AGAIN_ID).continueWhenText).toBe(CLAIM_AGAIN_CONTINUE_NEW);
    expect(byId(def, CLAIM_AGAIN_ID).continueWhenText).not.toBe(CLAIM_AGAIN_CONTINUE);
  });

  it("new copy carries no em dash and never says receptionist", () => {
    const def = patchedLive();
    const callback = byId(def, CALLBACK_GATE_ID);
    const blobs = [
      callback.question,
      String(callback.branches[0].label),
      byId(def, UNCLAIMED_CELL_SKIP_ID).question,
      String(byId(def, UNCLAIMED_CELL_SKIP_ID).branches[0].label),
      String(byId(def, UNCLAIMED_CELL_SKIP_ID).branches[1].label),
      CELL_ALERT_MESSAGE,
      CALLBACK_FIELD.description
    ];
    for (const s of blobs) {
      expect(s).not.toMatch(/\u2014/);
      expect(s.toLowerCase()).not.toContain("receptionist");
      expect(s.toLowerCase()).not.toContain("enquiry");
    }
  });

  it("refuses apply on every nested call-arm id the wrap would skip", () => {
    const def = patchedLive();
    const flat = flattenSteps(def.steps as never);
    const wait2 = flat.find((e) => e.step.id === WAIT2_ID);
    const route = flat.find((e) => e.step.id === ROUTE_ID);
    expect(wait2).toBeTruthy();
    expect(route).toBeTruthy();
    expect(wait2!.branchPath.some((h) => h.branchStepId === CALLBACK_GATE_ID)).toBe(true);
    expect(route!.branchPath.some((h) => h.branchStepId === CALLBACK_GATE_ID)).toBe(true);
    const withoutHop = {
      [branchChoiceVar(OFFER_GATE_ID)]: OFFER_CALL_ARM_ID
    };
    expect(isOnActivePath(wait2!.branchPath, withoutHop)).toBe(false);
    expect(isOnActivePath(route!.branchPath, withoutHop)).toBe(false);
    const withHop = {
      ...withoutHop,
      [branchChoiceVar(CALLBACK_GATE_ID)]: BRANCH_ELSE_ARM,
      [branchChoiceVar(RECALL_GATE_ID)]: RECALL_ARM_ID
    };
    expect(isOnActivePath(wait2!.branchPath, withHop)).toBe(true);
    expect(SHIFT_UNSAFE_RESUME_IDS).toEqual(
      expect.arrayContaining([WAIT2_ID, ROUTE_ID, NO_CALL_MSG_ID, RECALL_GATE_ID])
    );
  });

  it("does not send the not-claimed notice after a call-mode cell-callback alert", () => {
    const def = patchedLive();
    const skip = byId(def, UNCLAIMED_CELL_SKIP_ID);
    expect(skip.type).toBe("branch");
    expect(skip.branches).toHaveLength(2);
    expect(skip.branches[0].id).toBe(UNCLAIMED_TEXT_ARM_ID);
    expect(skip.branches[0].condition).toEqual(CLAIM_MODE_NOT_CALL_WHEN);
    expect(skip.branches[0].steps.map((s: Step) => s.id)).toEqual([NOTIFY_UNCLAIMED_ID]);
    expect(skip.branches[1].id).toBe(UNCLAIMED_AI_CALLBACK_ARM_ID);
    expect(skip.branches[1].condition).toEqual(CALLBACK_NOT_CELL_WHEN);
    expect(skip.branches[1].steps.map((s: Step) => s.id)).toEqual([NOTIFY_UNCLAIMED_AI_ID]);
    expect(skip.else).toEqual([]);
    const textNotice = byId(def, NOTIFY_UNCLAIMED_ID);
    const aiNotice = byId(def, NOTIFY_UNCLAIMED_AI_ID);
    expect(aiNotice.type).toBe("notify_owner");
    expect(aiNotice.message).toBe(textNotice.message);
    expect(aiNotice.when).toEqual({ var: "claimed_agent", equals: "none" });
    expect(evaluateStepCondition(CLAIM_MODE_NOT_CALL_WHEN, { vars: { claim_mode: "text" } })).toBe(
      true
    );
    expect(evaluateStepCondition(CLAIM_MODE_NOT_CALL_WHEN, { vars: { claim_mode: "call" } })).toBe(
      false
    );
    expect(evaluateStepCondition(CALLBACK_NOT_CELL_WHEN, { vars: { [CALLBACK_VAR]: "no" } })).toBe(
      false
    );
    expect(evaluateStepCondition(CALLBACK_NOT_CELL_WHEN, { vars: { [CALLBACK_VAR]: "yes" } })).toBe(
      true
    );
    expect(evaluateStepCondition(CALLBACK_NOT_CELL_WHEN, { vars: {} })).toBe(true);
    expect(
      evaluateStepCondition(CLAIM_MODE_NOT_CALL_WHEN, {
        vars: { claim_mode: "text", [CALLBACK_VAR]: "no" }
      })
    ).toBe(true);
  });

  it("formats the live Telnyx DID the way the claim page shows it", () => {
    expect(formatAiDidDisplay("+16028053377")).toBe("602 805 3377");
    expect(formatAiDidDisplay("6028053377")).toBe("602 805 3377");
    expect(formatAiDidDisplay("")).toBe("");
  });

  it("retargets a 415 callback field to the AI DID without wrapping again", () => {
    const def = patchedLive();
    const open = byId(def, OPEN_ID);
    const idx = open.fields.findIndex((f: { name?: string }) => f.name === CALLBACK_VAR);
    open.fields[idx] = callbackField("415 985 1909");
    const edits = patchDefinition(def);
    expect(edits).toEqual([`retarget "${CALLBACK_VAR}" to the AI DID ${AI_DID_DISPLAY}`]);
    expect(open.fields[idx]).toEqual(CALLBACK_FIELD);
    expect(findStep(def, CALLBACK_GATE_ID)).toBeTruthy();
  });
});
