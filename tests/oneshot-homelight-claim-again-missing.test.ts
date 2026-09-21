import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { MISSING_CONTROL_VAR_VALUE } from "../supabase/functions/_shared/ai_flows/page_markers";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { patchDefinition as patchTextClaimDetails } from "../scripts/oneshot/homelight-text-claim-details-definition";
import { patchDefinition as patchNocall } from "../scripts/oneshot/homelight-nocall-contact-definition";
import { patchDefinition as patchCallsCell } from "../scripts/oneshot/homelight-claim-calls-cell-definition";
import { patchDefinition as patchOverlay } from "../scripts/oneshot/homelight-own-claim-overlay-definition";
import { CLAIM_AGAIN_ID, WAIT2_ID } from "../scripts/oneshot/homelight-nocall-contact-definition";
import { findStep, type Definition } from "../scripts/oneshot/homelight-text-claim-details-definition";
import {
  CLAIM_AGAIN_CLICK_VAR,
  CLAIM_AGAIN_MISS_ID,
  CLAIM_AGAIN_MISS_MESSAGE,
  MISS_NOTIFY_WHEN,
  SHIFT_UNSAFE_RESUME_IDS,
  WAIT2_WHEN,
  patchDefinition
} from "../scripts/oneshot/homelight-claim-again-missing-definition";

/**
 * homelight-claim-again-missing.ts.
 *
 * 2026-09-21: Natasha W. (San Tan Valley, AZ, ~$547K, runs 7ce0e9c3 /
 * 06229aed). Call-mode, wait_hl_call no_call, claim_state Other brokerage.
 * claim_again click_text "Call me again" found no matching control.
 */

type Step = Record<string, any>;

function liveDefinition(): Definition {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "homelight-referral-live-2026-09-13.json"), "utf8")
  ) as Definition;
}

function stacked(): Definition {
  const def = liveDefinition();
  patchClaimThenOffer(def);
  patchTextClaimDetails(def);
  patchNocall(def);
  patchCallsCell(def);
  patchOverlay(def);
  return def;
}

function patchedLive(): Definition {
  const def = stacked();
  patchDefinition(def);
  return def;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  if (!step) throw new Error(`missing ${id}`);
  return step;
}

describe("homelight-claim-again-missing", () => {
  it("patches the stacked live definition and stays valid at trunk 28", () => {
    const def = stacked();
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = patchedLive();
    expect(patchDefinition(def)).toEqual([]);
  });

  it("opts claim_again into missing-control continue and writes the save-as var", () => {
    const def = patchedLive();
    const again = byId(def, CLAIM_AGAIN_ID);
    expect(again.continueWhenMissingControl).toBe(true);
    expect(again.missingControlSaveAs).toBe(CLAIM_AGAIN_CLICK_VAR);
    expect(again.continueWhenText).toBe("We're calling you");
    expect(again.actions).toEqual([{ kind: "click_text", target: "Call me again" }]);
  });

  it("skips the second wait when the click was missing, and waits when it was not", () => {
    const def = patchedLive();
    expect(byId(def, WAIT2_ID).when).toEqual(WAIT2_WHEN);
    expect(
      evaluateStepCondition(WAIT2_WHEN, { vars: { [CLAIM_AGAIN_CLICK_VAR]: MISSING_CONTROL_VAR_VALUE } })
    ).toBe(false);
    expect(evaluateStepCondition(WAIT2_WHEN, { vars: {} })).toBe(true);
    expect(evaluateStepCondition(WAIT2_WHEN, { vars: { [CLAIM_AGAIN_CLICK_VAR]: "clicked" } })).toBe(
      true
    );
  });

  it("texts the owner only when the button was gone", () => {
    const def = patchedLive();
    const miss = byId(def, CLAIM_AGAIN_MISS_ID);
    expect(miss.type).toBe("notify_owner");
    expect(miss.when).toEqual(MISS_NOTIFY_WHEN);
    expect(miss.message).toBe(CLAIM_AGAIN_MISS_MESSAGE);
    expect(
      evaluateStepCondition(MISS_NOTIFY_WHEN, {
        vars: { [CLAIM_AGAIN_CLICK_VAR]: MISSING_CONTROL_VAR_VALUE }
      })
    ).toBe(true);
    expect(evaluateStepCondition(MISS_NOTIFY_WHEN, { vars: {} })).toBe(false);
    expect([...SHIFT_UNSAFE_RESUME_IDS]).toEqual([]);
  });

  it("copy carries no em dash, receptionist, or enquiry", () => {
    expect(CLAIM_AGAIN_MISS_MESSAGE).not.toMatch(/\u2014/);
    expect(CLAIM_AGAIN_MISS_MESSAGE.toLowerCase()).not.toContain("receptionist");
    expect(CLAIM_AGAIN_MISS_MESSAGE.toLowerCase()).not.toContain("enquiry");
  });
});
