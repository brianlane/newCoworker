import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { patchDefinition as patchTextClaimDetails } from "../scripts/oneshot/homelight-text-claim-details-definition";
import { BRIEF_ID, NO_CALL_MSG_ID, OFFER_CALL_ARM_ID, OFFER_GATE_ID, ROUTE_ID, WAIT_ID } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { PHONE_MISS_ID, PORTAL_ALERT_ID, findStep, type Definition } from "../scripts/oneshot/homelight-text-claim-details-definition";
import {
  CLAIM_AGAIN_ID,
  CONTACT_FOUND_WHEN,
  LATE2_WAIT_ID,
  LATE2_WAIT_MINUTES,
  LEAD_EMAIL_ID,
  LEAD_SMS_ID,
  NOTE_ID,
  PORTAL_EMAIL_ID,
  PORTAL_SMS_ID,
  RECALL_ARM_ID,
  RECALL_GATE_ID,
  RECALL_PAUSE_ID,
  RECALL_PAUSE_MINUTES,
  ROSTER_CLAIM_WHEN,
  WAIT2_ID,
  patchDefinition
} from "../scripts/oneshot/homelight-nocall-contact-definition";

/**
 * homelight-nocall-contact.ts.
 *
 * 2026-09-14: Sharon I. (San Tan Valley, ~$391K, run 89268fa7) and Brandi V.
 * (Vaccaro, ~$300K, run 62ecd626). Call-mode, claim_state Call me again /
 * We're calling you, wait_hl_call no_call, claimed_agent none. HomeLight
 * nagged Amy at 30 minutes. Seller intro waited on a roster press-1 that
 * never came, then slept 60 minutes at late2_wait.
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
  patchDefinition(def);
  return def;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  expect(step, `step "${id}"`).toBeTruthy();
  return step as Step;
}

describe("homelight-nocall-contact", () => {
  it("patches the post-text-claim-details snapshot into a valid definition", () => {
    const def = liveDefinition();
    patchClaimThenOffer(def);
    patchTextClaimDetails(def);
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = patchedLive();
    expect(patchDefinition(def)).toEqual([]);
  });

  it("does not break a later re-run of claim-then-offer", () => {
    const def = patchedLive();
    expect(patchClaimThenOffer(def)).toEqual([]);
  });

  it("retries Claim after no_call, then waits again before the offer", () => {
    const def = patchedLive();
    const gate = byId(def, OFFER_GATE_ID);
    const callArm = gate.branches.find((b: Step) => b.id === OFFER_CALL_ARM_ID);
    expect(callArm.steps.map((s: Step) => s.id)).toEqual([
      BRIEF_ID,
      WAIT_ID,
      RECALL_GATE_ID,
      ROUTE_ID,
      NO_CALL_MSG_ID
    ]);
    const recall = byId(def, RECALL_GATE_ID);
    expect(recall.type).toBe("branch");
    expect(recall.branches).toHaveLength(1);
    expect(recall.branches[0].id).toBe(RECALL_ARM_ID);
    expect(recall.branches[0].condition).toEqual({ var: "hl_call_outcome", equals: "no_call" });
    expect(recall.branches[0].steps.map((s: Step) => s.id)).toEqual([
      RECALL_PAUSE_ID,
      CLAIM_AGAIN_ID,
      WAIT2_ID
    ]);
    expect(recall.else).toEqual([]);
    expect(byId(def, RECALL_PAUSE_ID)).toMatchObject({
      type: "sleep",
      minutes: RECALL_PAUSE_MINUTES
    });
    expect(byId(def, CLAIM_AGAIN_ID).type).toBe("browse_action");
    expect(byId(def, CLAIM_AGAIN_ID).continueWhenText).toBe("HomeLight");
    expect(byId(def, CLAIM_AGAIN_ID).when).toBeUndefined();
    const wait2 = byId(def, WAIT2_ID);
    expect(wait2.type).toBe("wait_for_call");
    expect(wait2.saveAs).toBe("hl_call_outcome");
    expect(wait2.awaitStartMinutes).toBe(6);
    expect(wait2.when).toBeUndefined();
    expect(byId(def, ROUTE_ID).when).toEqual({
      var: "hl_call_outcome",
      notEquals: "no_call"
    });
  });

  it("texts the seller when the mailbox found a number, even if nobody pressed 1", () => {
    const def = patchedLive();
    expect(byId(def, LEAD_SMS_ID).when).toEqual(CONTACT_FOUND_WHEN);
    expect(byId(def, LEAD_EMAIL_ID).when).toEqual(CONTACT_FOUND_WHEN);
    expect(evaluateStepCondition(CONTACT_FOUND_WHEN, { vars: { contact_status: "found" } })).toBe(
      true
    );
    expect(
      evaluateStepCondition(CONTACT_FOUND_WHEN, { vars: { contact_status: "missing" } })
    ).toBe(false);
    expect(evaluateStepCondition(CONTACT_FOUND_WHEN, { vars: { claimed_agent: "none" } })).toBe(
      false
    );
    expect(
      evaluateStepCondition(CONTACT_FOUND_WHEN, {
        vars: { contact_status: "found", claimed_agent: "none" }
      })
    ).toBe(true);
  });

  it("looks again for the details email at 15 minutes, not 60", () => {
    const def = patchedLive();
    expect(byId(def, LATE2_WAIT_ID).minutes).toBe(LATE2_WAIT_MINUTES);
  });

  it("texts the seller from the portal card when the mailbox missed and a phone landed", () => {
    const def = patchedLive();
    const miss = byId(def, PHONE_MISS_ID);
    expect(miss.else.map((s: Step) => s.id)).toEqual([
      PORTAL_SMS_ID,
      PORTAL_EMAIL_ID,
      PORTAL_ALERT_ID
    ]);
    const sms = byId(def, PORTAL_SMS_ID);
    expect(sms.type).toBe("send_sms");
    expect(sms.to).toBe("{{vars.lead_phone}}");
    expect(sms.when).toEqual({ var: "lead_phone", contains: "+" });
    expect(evaluateStepCondition(sms.when, { vars: { lead_phone: "" } })).toBe(false);
    expect(evaluateStepCondition(sms.when, { vars: { lead_phone: "none" } })).toBe(false);
    expect(evaluateStepCondition(sms.when, { vars: { lead_phone: "+extracted-phone" } })).toBe(
      true
    );
    const email = byId(def, PORTAL_EMAIL_ID);
    expect(email.type).toBe("send_email");
    expect(email.when).toEqual({ var: "lead_email", contains: "@" });
    expect(evaluateStepCondition(email.when, { vars: { lead_email: "none" } })).toBe(false);
    expect(evaluateStepCondition(email.when, { vars: { lead_email: "lead@example.com" } })).toBe(
      true
    );
  });

  it("posts the HomeLight portal note only when someone on the roster claimed", () => {
    const def = patchedLive();
    expect(byId(def, NOTE_ID).when).toEqual(ROSTER_CLAIM_WHEN);
    expect(evaluateStepCondition(ROSTER_CLAIM_WHEN, { vars: { claimed_agent: "none" } })).toBe(
      false
    );
    expect(
      evaluateStepCondition(ROSTER_CLAIM_WHEN, { vars: { claimed_agent: "Amy Laidlaw" } })
    ).toBe(true);
  });

  it("new copy carries no em dash and never says receptionist", () => {
    const def = patchedLive();
    const recall = byId(def, RECALL_GATE_ID);
    for (const s of [recall.question, String(recall.branches[0].label)]) {
      expect(s).not.toMatch(/\u2014/);
      expect(s.toLowerCase()).not.toContain("receptionist");
      expect(s.toLowerCase()).not.toContain("enquiry");
    }
  });
});
