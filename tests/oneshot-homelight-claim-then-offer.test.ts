import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { evaluateSmsTrigger, evaluateStepCondition } from "../supabase/functions/_shared/ai_flows/engine";
import {
  BRIEF_ID,
  CALL_OFFER_LINE,
  CLAIM_FIX_ID,
  LOST_ALERT_ID,
  LOST_ALERT_MESSAGE,
  NO_CALL_MESSAGE,
  NO_CALL_MSG_ID,
  NOTIFY_UNCLAIMED_ID,
  OFFER_CALL_ARM_ID,
  OFFER_GATE_ID,
  OFFER_TEXT_ARM_ID,
  RETARGET_IDS,
  ROUTE_ID,
  ROUTE_TEXT_ID,
  UNCLAIMED_NOTICE_ID,
  WAIT_ID,
  findStep,
  patchDefinition,
  type Definition
} from "../scripts/oneshot/homelight-claim-then-offer-definition";

/**
 * homelight-claim-then-offer.ts.
 *
 * 2026-09-13: Sonia R. (Queen Creek AZ, $448,159). HomeLight's alert and URL
 * arrived 35ms apart; the webhook evaluated each before persisting, so neither
 * matched. The withdrawal 16s later started the run. The portal was already
 * lost (`claim_mode=none`) and `route_to_team` still offered a press-1 race.
 * The fixture is the live definition of 2026-09-13.
 */

type Step = Record<string, any>;

function liveDefinition(): Definition {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "homelight-referral-live-2026-09-13.json"), "utf8")
  ) as Definition;
}

function byId(def: Definition, id: string): Step {
  const step = findStep(def, id);
  expect(step, `step "${id}"`).toBeTruthy();
  return step as Step;
}

describe("homelight-claim-then-offer", () => {
  it("patches the live snapshot into a definition the platform validator accepts", () => {
    const def = liveDefinition();
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(def.steps!.length).toBeLessThanOrEqual(30);
    expect(def.steps!.length).toBe(28);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = liveDefinition();
    patchDefinition(def);
    expect(patchDefinition(def)).toEqual([]);
  });

  it("nests claim-then-offer behind offer_gate and keeps unique step ids", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const ids = def.steps!.map((s) => s.id);
    expect(ids.indexOf(CLAIM_FIX_ID)).toBeGreaterThan(-1);
    expect(ids[ids.indexOf(CLAIM_FIX_ID) + 1]).toBe("card");
    expect(ids[ids.indexOf("card") + 1]).toBe(OFFER_GATE_ID);
    expect(ids).not.toContain(ROUTE_ID);
    expect(ids).not.toContain(WAIT_ID);
    expect(ids).not.toContain(BRIEF_ID);
    expect(ids).not.toContain(NOTIFY_UNCLAIMED_ID);
    expect(ids).toContain(UNCLAIMED_NOTICE_ID);

    const gate = byId(def, OFFER_GATE_ID);
    const textArm = gate.branches.find((b: Step) => b.id === OFFER_TEXT_ARM_ID);
    const callArm = gate.branches.find((b: Step) => b.id === OFFER_CALL_ARM_ID);
    expect(textArm.condition).toEqual({ var: "claim_mode", equals: "text" });
    expect(callArm.condition).toEqual({ var: "claim_mode", equals: "call" });
    expect(textArm.steps.map((s: Step) => s.id)).toEqual([ROUTE_TEXT_ID]);
    expect(callArm.steps.map((s: Step) => s.id)).toEqual([
      BRIEF_ID,
      WAIT_ID,
      ROUTE_ID,
      NO_CALL_MSG_ID
    ]);
    expect(gate.else.map((s: Step) => s.id)).toEqual([LOST_ALERT_ID]);
  });

  it("briefs then waits before the call-path offer, and skips the offer on no_call", () => {
    const def = liveDefinition();
    patchDefinition(def);
    expect(byId(def, BRIEF_ID).when).toBeUndefined();
    expect(byId(def, WAIT_ID).when).toBeUndefined();
    expect(byId(def, WAIT_ID).awaitStartMinutes).toBe(6);
    expect(byId(def, ROUTE_ID).when).toEqual({
      var: "hl_call_outcome",
      notEquals: "no_call"
    });
    expect(byId(def, NO_CALL_MSG_ID).when).toEqual({
      var: "hl_call_outcome",
      equals: "no_call"
    });
    expect(byId(def, ROUTE_ID).offerTemplate).toContain(CALL_OFFER_LINE);
    expect(byId(def, ROUTE_TEXT_ID).offerTemplate).not.toContain(CALL_OFFER_LINE);
    expect(byId(def, ROUTE_TEXT_ID).offerTemplate).toContain("First to reply 1 gets it.");
  });

  it("lost and no-call notices are alerts, not press-1 offers", () => {
    const def = liveDefinition();
    patchDefinition(def);
    for (const id of [LOST_ALERT_ID, NO_CALL_MSG_ID]) {
      const step = byId(def, id);
      expect(step.type).toBe("notify_lead_owner");
      expect(step.unownedFallback).toBe("team");
      expect(step.teamTagTemplate).toBe("{{vars.lead_type}}");
      expect(step.message).not.toMatch(/reply\s*1/i);
      expect(step.message).not.toMatch(/first to reply/i);
    }
    expect(byId(def, LOST_ALERT_ID).message).toBe(LOST_ALERT_MESSAGE);
    expect(byId(def, NO_CALL_MSG_ID).message).toBe(NO_CALL_MESSAGE);
    expect(LOST_ALERT_MESSAGE.length).toBeLessThanOrEqual(1000);
    expect(NO_CALL_MESSAGE.length).toBeLessThanOrEqual(1000);
  });

  it("retargets portal reads off the team claimer so a no-call still gathers details", () => {
    const def = liveDefinition();
    patchDefinition(def);
    for (const id of RETARGET_IDS) {
      expect(byId(def, id).when, id).toEqual({ var: "claim_mode", notEquals: "none" });
    }
    expect(byId(def, "save_contact").when).toBeUndefined();
    expect(byId(def, "to_agent").when).toEqual({ var: "claimed_agent", notEquals: "none" });
  });

  it("does not wrap notify_unclaimed around lost or no-call runs", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const notice = byId(def, UNCLAIMED_NOTICE_ID);
    expect(notice.branches[0].condition).toEqual({ var: "claim_mode", notEquals: "none" });
    const inner = notice.branches[0].steps[0];
    expect(inner.id).toBe("unclaimed_not_nocall");
    expect(inner.branches[0].condition).toEqual({
      var: "hl_call_outcome",
      notEquals: "no_call"
    });
    expect(inner.branches[0].steps[0].id).toBe(NOTIFY_UNCLAIMED_ID);
    expect(inner.branches[0].steps[0].when).toEqual({ var: "claimed_agent", equals: "none" });
  });

  it("new copy carries no em dash and never says receptionist", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const strings = [
      CALL_OFFER_LINE,
      NO_CALL_MESSAGE,
      LOST_ALERT_MESSAGE,
      byId(def, ROUTE_ID).offerTemplate,
      byId(def, ROUTE_TEXT_ID).offerTemplate,
      byId(def, LOST_ALERT_ID).message,
      byId(def, NO_CALL_MSG_ID).message
    ];
    for (const s of strings) {
      expect(s).not.toMatch(/\u2014/);
      expect(s.toLowerCase()).not.toContain("receptionist");
      expect(s.toLowerCase()).not.toContain("enquiry");
    }
  });

  it("keeps startImmediately and does not set allowReentry false", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const options = (def.options ?? {}) as Record<string, unknown>;
    expect(options.startImmediately).toBe(true);
    expect(options.suppressDefaultReply).toBe(true);
    expect(options.allowReentry).not.toBe(false);
  });

  it("refuses when the live trunk is not the expected shape", () => {
    const def = liveDefinition();
    def.steps = def.steps!.filter((s) => s.id !== ROUTE_ID);
    expect(() => patchDefinition(def)).toThrow(/no trunk step "route"/);
  });

  it("refuses when the offer copy is no longer the press-1 race", () => {
    const def = liveDefinition();
    byId(def, ROUTE_ID).offerTemplate = "Hello";
    expect(() => patchDefinition(def)).toThrow(/offerTemplate/);
  });
});

describe("HomeLight SMS trigger (Sonia window)", () => {
  const trig = {
    channel: "sms" as const,
    correlationWindowMinutes: 15,
    conditions: [
      { type: "has_url" as const },
      {
        type: "regex" as const,
        value: "New HomeLight (Referral|Warm Transfer)",
        caseInsensitive: true
      }
    ]
  };
  const from = "+14158553933";
  const now = 2_000_000_000_000;
  function ctx(texts: string[]) {
    return {
      nowMs: now,
      messages: texts.map((text) => ({ text, from, atMs: now }))
    };
  }

  it("needs both the alert wording and the URL; either alone fails", () => {
    expect(
      evaluateSmsTrigger(
        trig,
        ctx(["New HomeLight Warm Transfer Opportunity: Sonia - $448K seller in Queen Creek AZ"])
      ).matched
    ).toBe(false);
    expect(evaluateSmsTrigger(trig, ctx(["https://hmlt.co/08dba950"])).matched).toBe(false);
    expect(
      evaluateSmsTrigger(
        trig,
        ctx([
          "New HomeLight Warm Transfer Opportunity: Sonia - $448K seller in Queen Creek AZ",
          "https://hmlt.co/08dba950"
        ])
      ).matched
    ).toBe(true);
  });

  it("keys trigger.url on the newest hmlt.co, not an earlier referral still in the window", () => {
    const r = evaluateSmsTrigger(
      trig,
      ctx([
        "New HomeLight Referral Opportunity: earlier lead https://hmlt.co/old",
        "New HomeLight Warm Transfer Opportunity: Sonia - $448K seller in Queen Creek AZ",
        "https://hmlt.co/08dba950"
      ])
    );
    expect(r.matched).toBe(true);
    expect(r.url).toBe("https://hmlt.co/08dba950");
  });

  it("a missing hl_call_outcome passes notEquals no_call, so wait must not be skipped", () => {
    expect(
      evaluateStepCondition({ var: "hl_call_outcome", notEquals: "no_call" }, { vars: {} })
    ).toBe(true);
    expect(
      evaluateStepCondition(
        { var: "hl_call_outcome", notEquals: "no_call" },
        { vars: { hl_call_outcome: "no_call" } }
      )
    ).toBe(false);
    expect(
      evaluateStepCondition(
        { var: "hl_call_outcome", notEquals: "no_call" },
        { vars: { hl_call_outcome: "answered" } }
      )
    ).toBe(true);
  });
});
