import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { patchDefinition as patchTextClaimDetails } from "../scripts/oneshot/homelight-text-claim-details-definition";
import { patchDefinition as patchNocall } from "../scripts/oneshot/homelight-nocall-contact-definition";
import { patchDefinition as patchCallsCell } from "../scripts/oneshot/homelight-claim-calls-cell-definition";
import { CLAIM_STATE_FIELD, STATE_SENT, STATE_TAKEN } from "../scripts/oneshot/homelight-verified-claim";
import {
  CARD_ID,
  VERIFY_ID,
  VERIFY2_ID,
  findStep,
  type Definition
} from "../scripts/oneshot/homelight-text-claim-details-definition";
import { CLAIM_AGAIN_ID } from "../scripts/oneshot/homelight-nocall-contact-definition";
import { ROUTE_ID, ROUTE_TEXT_ID } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import {
  SHIFT_UNSAFE_RESUME_IDS,
  VERIFY_CLAIMED_WHEN,
  patchDefinition
} from "../scripts/oneshot/homelight-own-claim-overlay-definition";

/**
 * homelight-own-claim-overlay.ts.
 *
 * 2026-09-16: Debra M. (Mesa AZ, ~$227K, run aaeb08fb). Call-mode Claim
 * clicked. HomeLight showed "already claimed by another agent". That was
 * OUR claim. card screenshotted the overlay; route MMSed it onto the team
 * offer as Claim: another agent has it.
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
  patchCallsCell(def);
  patchDefinition(def);
  return def;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`missing ${id}`);
  return step;
}

describe("homelight-own-claim-overlay", () => {
  it("patches the stacked live definition and stays valid at trunk 28", () => {
    const def = liveDefinition();
    patchClaimThenOffer(def);
    patchTextClaimDetails(def);
    patchNocall(def);
    patchCallsCell(def);
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = patchedLive();
    expect(patchDefinition(def)).toEqual([]);
  });

  it("teaches claim_state that the already-claimed dialog after we clicked is ours", () => {
    expect(CLAIM_STATE_FIELD.description.length).toBeLessThanOrEqual(300);
    expect(CLAIM_STATE_FIELD.description).toContain("Amy Laidlaw");
    expect(CLAIM_STATE_FIELD.description).toContain("already-claimed dialog");
    expect(CLAIM_STATE_FIELD.description).toContain(STATE_SENT);
    expect(CLAIM_STATE_FIELD.description).toContain(STATE_TAKEN);
    const def = patchedLive();
    for (const id of [VERIFY_ID, VERIFY2_ID]) {
      expect(byId(def, id).fields).toEqual([CLAIM_STATE_FIELD]);
    }
    expect(byId(def, VERIFY_ID).when).toEqual(VERIFY_CLAIMED_WHEN);
    // Skip on a true rival (Sonia, claim_mode=none). Running the overlay-as-ours
    // prompt there would relabel a lead we never clicked as claim message sent.
    expect(evaluateStepCondition(VERIFY_CLAIMED_WHEN, { vars: { claim_mode: "call" } })).toBe(
      true
    );
    expect(evaluateStepCondition(VERIFY_CLAIMED_WHEN, { vars: { claim_mode: "text" } })).toBe(
      true
    );
    expect(evaluateStepCondition(VERIFY_CLAIMED_WHEN, { vars: { claim_mode: "none" } })).toBe(
      false
    );
  });

  it("does not MMS the overlay; contact-card screenshot stays on qt_email", () => {
    const def = patchedLive();
    expect(byId(def, CARD_ID).screenshot).toBeUndefined();
    expect(byId(def, CLAIM_AGAIN_ID).screenshot).toBeUndefined();
    expect(byId(def, ROUTE_ID).attachScreenshot).toBeUndefined();
    expect(byId(def, ROUTE_TEXT_ID).attachScreenshot).toBeUndefined();
    expect(byId(def, "open").screenshot).toBe(true);
    expect(byId(def, "final_read").screenshot).toBe(true);
    expect(byId(def, "qt_email").attachScreenshot).toBe(true);
    expect(byId(def, "late2_portal").screenshot).toBe(true);
    expect([...SHIFT_UNSAFE_RESUME_IDS]).toEqual([]);
  });

  it("copy carries no em dash, receptionist, or enquiry", () => {
    expect(CLAIM_STATE_FIELD.description).not.toMatch(/\u2014/);
    expect(CLAIM_STATE_FIELD.description.toLowerCase()).not.toContain("receptionist");
    expect(CLAIM_STATE_FIELD.description.toLowerCase()).not.toContain("enquiry");
  });
});
