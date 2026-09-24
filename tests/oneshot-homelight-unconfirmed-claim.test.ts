import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { STATE_UNCONFIRMED } from "../scripts/oneshot/homelight-verified-claim";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { patchDefinition as patchTextClaimDetails } from "../scripts/oneshot/homelight-text-claim-details-definition";
import { patchDefinition as patchNocall } from "../scripts/oneshot/homelight-nocall-contact-definition";
import { patchDefinition as patchCallsCell } from "../scripts/oneshot/homelight-claim-calls-cell-definition";
import { patchDefinition as patchOverlay } from "../scripts/oneshot/homelight-own-claim-overlay-definition";
import { patchDefinition as patchClaimAgainMissing } from "../scripts/oneshot/homelight-claim-again-missing-definition";
import { OFFER_GATE_ID } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { findStep, type Definition } from "../scripts/oneshot/homelight-text-claim-details-definition";
import {
  CALLBACK_PHONE_NOTE,
  SHIFT_UNSAFE_RESUME_IDS,
  UNCONFIRMED_ALERT_ID,
  UNCONFIRMED_ALERT_MESSAGE,
  UNCONFIRMED_ARM_ID,
  UNCONFIRMED_BUTTON,
  UNCONFIRMED_WHEN,
  VERIFY_IDS,
  patchDefinition
} from "../scripts/oneshot/homelight-unconfirmed-claim-definition";

/**
 * homelight-unconfirmed-claim.ts.
 *
 * 2026-09-23: Ron G. (Mesa, AZ, ~$625K, run e7c5e9b3). The claim button was
 * still on the page. The model answered "Call me again", so the retry never
 * ran and the team was told the referral had been claimed.
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
  patchClaimAgainMissing(def);
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

describe("homelight-unconfirmed-claim", () => {
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

  it("forces NOT CONFIRMED while the original claim button is still on the page", () => {
    const def = patchedLive();
    for (const id of VERIFY_IDS) {
      const step = byId(def, id);
      expect(step.forceWhenText).toEqual([
        { contains: UNCONFIRMED_BUTTON, set: { claim_state: STATE_UNCONFIRMED } }
      ]);
    }
  });

  it("alerts the owner first and does not enter the call arm when the claim is unconfirmed", () => {
    const def = patchedLive();
    const gate = byId(def, OFFER_GATE_ID);
    expect(gate.branches[0].id).toBe(UNCONFIRMED_ARM_ID);
    expect(gate.branches[0].condition).toEqual(UNCONFIRMED_WHEN);
    const alert = gate.branches[0].steps[0];
    expect(alert.id).toBe(UNCONFIRMED_ALERT_ID);
    expect(alert.type).toBe("notify_owner");
    expect(alert.message).toBe(UNCONFIRMED_ALERT_MESSAGE);
    expect(alert.message.toLowerCase()).not.toContain("reply 1");
    expect(alert.message).not.toMatch(/\u2014/);
    expect(evaluateStepCondition(UNCONFIRMED_WHEN, { vars: { claim_state: STATE_UNCONFIRMED } })).toBe(
      true
    );
    expect(evaluateStepCondition(UNCONFIRMED_WHEN, { vars: { claim_state: "Call me again" } })).toBe(
      false
    );
    expect(evaluateStepCondition(UNCONFIRMED_WHEN, { vars: {} })).toBe(false);
    expect([...SHIFT_UNSAFE_RESUME_IDS]).toEqual([]);
  });

  it("tells the phone field that the callback line is not the seller", () => {
    const def = patchedLive();
    const card = byId(def, "card");
    const phone = (card.fields as Array<{ name: string; description: string }>).find(
      (f) => f.name === "lead_phone"
    );
    expect(phone?.description).toContain(CALLBACK_PHONE_NOTE.trim());
    expect((phone?.description ?? "").length).toBeLessThanOrEqual(300);
  });
});
