import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import { patchDefinition as patchClaimThenOffer } from "../scripts/oneshot/homelight-claim-then-offer-definition";
import { CLAIM_STATE_FIELD, STATE_SENT, STATE_TAKEN } from "../scripts/oneshot/homelight-verified-claim";
import {
  NEVER_AGENT_BODY,
  NEVER_AGENT_ID,
  NEVER_NOTIFY_ID,
  NEVER_NOTIFY_MESSAGE,
  PHONE_MISS_ARM_ID,
  PHONE_MISS_ID,
  PORTAL_ALERT_ID,
  PORTAL_ALERT_MESSAGE,
  PORTAL_ID,
  VERIFY2_ID,
  VERIFY_ID,
  findStep,
  patchDefinition,
  type Definition
} from "../scripts/oneshot/homelight-text-claim-details-definition";

/**
 * homelight-text-claim-details.ts.
 *
 * 2026-09-14: Vince N. (85140, ~$428K), run e09b3f18. Text claim completed.
 * The portal showed Claimed By Amy Laidlaw and the full contact card.
 * claim_state still said another agent has it. Three mailbox reads returned
 * found:false. late2_never_notify said the contact never arrived.
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
  patchDefinition(def);
  return def;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  expect(step, `step "${id}"`).toBeTruthy();
  return step as Step;
}

describe("homelight-text-claim-details", () => {
  it("patches the post-offer_gate snapshot into a valid definition", () => {
    const def = liveDefinition();
    patchClaimThenOffer(def);
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = liveDefinition();
    patchClaimThenOffer(def);
    patchDefinition(def);
    expect(patchDefinition(def)).toEqual([]);
  });

  it("teaches claim_state that Claimed By this team is our claim", () => {
    expect(CLAIM_STATE_FIELD.description.length).toBeLessThanOrEqual(300);
    expect(CLAIM_STATE_FIELD.description).toContain("Amy Laidlaw");
    expect(CLAIM_STATE_FIELD.description).toContain(STATE_SENT);
    expect(CLAIM_STATE_FIELD.description).toContain(STATE_TAKEN);
    const def = patchedLive();
    for (const id of [VERIFY_ID, VERIFY2_ID]) {
      expect(byId(def, id).fields).toEqual([CLAIM_STATE_FIELD]);
    }
  });

  it("re-reads the portal before the never-sent alerts, and skips them when a phone landed", () => {
    const def = patchedLive();
    const portal = byId(def, PORTAL_ID);
    expect(portal.type).toBe("browse_extract");
    expect(portal.fillOnlyEmpty).toBe(true);
    expect(portal.screenshot).toBe(true);
    expect(portal.when).toEqual({ var: "late2_contact_status", notEquals: "found" });
    expect(portal.fields.map((f: { name: string }) => f.name)).toEqual([
      "lead_name",
      "lead_phone",
      "lead_email",
      "lead_address"
    ]);

    const miss = byId(def, PHONE_MISS_ID);
    expect(miss.type).toBe("branch");
    expect(miss.when).toEqual({ var: "late2_contact_status", notEquals: "found" });
    expect(miss.branches).toHaveLength(1);
    expect(miss.branches[0].id).toBe(PHONE_MISS_ARM_ID);
    expect(miss.branches[0].condition).toEqual({ var: "lead_phone", equals: "none" });
    expect(miss.branches[0].steps.map((s: Step) => s.id)).toEqual([NEVER_AGENT_ID, NEVER_NOTIFY_ID]);
    expect(miss.else).toHaveLength(1);
    expect(miss.else[0].id).toBe(PORTAL_ALERT_ID);
    expect(miss.else[0].type).toBe("notify_owner");
    expect(miss.else[0].message).toBe(PORTAL_ALERT_MESSAGE);
    expect(PORTAL_ALERT_MESSAGE.length).toBeLessThanOrEqual(1000);
    expect(PORTAL_ALERT_MESSAGE).not.toMatch(/Reply 1/i);

    const agent = byId(def, NEVER_AGENT_ID);
    const notify = byId(def, NEVER_NOTIFY_ID);
    expect(agent.when).toBeUndefined();
    expect(notify.when).toBeUndefined();
    expect(agent.body).toBe(NEVER_AGENT_BODY);
    expect(notify.message).toBe(NEVER_NOTIFY_MESSAGE);
    expect(NEVER_AGENT_BODY.toLowerCase()).not.toContain("live transfer");
    for (const s of [
      PORTAL_ALERT_MESSAGE,
      NEVER_AGENT_BODY,
      NEVER_NOTIFY_MESSAGE,
      CLAIM_STATE_FIELD.description
    ]) {
      expect(s).not.toMatch(/\u2014/);
      expect(s.toLowerCase()).not.toContain("receptionist");
      expect(s.toLowerCase()).not.toContain("enquiry");
    }
  });

  it("the never-sent arm is lead_phone equals none, so an empty phone does not take it", () => {
    const def = patchedLive();
    const miss = byId(def, PHONE_MISS_ID);
    const cond = miss.branches[0].condition;
    expect(evaluateStepCondition(cond, { vars: { lead_phone: "none" } })).toBe(true);
    expect(evaluateStepCondition(cond, { vars: { lead_phone: "" } })).toBe(false);
    expect(evaluateStepCondition(cond, { vars: {} })).toBe(false);
    expect(
      evaluateStepCondition(cond, { vars: { lead_phone: "extracted-phone" } })
    ).toBe(false);
  });
});
