/**
 * Regression pins for KYP Ads' "No-show recovery text" flow definition
 * (scripts/oneshot/kyp-noshow-definition.ts) — the builder
 * patch-kyp-noshow-links.ts re-applies to the live tenant.
 *
 * Incident (Jul 20 2026, Tim Tsai): the flow hardcoded the $200 booking link
 * for every no-show, so a $100/week lead who no-showed his
 * "KYP Ads | Free Strategy Call" ($100 event) was texted the
 * "KYP Ads | Free Strategy Call | 2" ($200 event) link. These tests walk the
 * definition with the REAL branch chooser and pin: a "| 2" no-show gets the
 * $200 link back, any other Free Strategy Call no-show gets the $100 link,
 * and an unrecognized event type texts the lead NOTHING (owner-only), so a
 * future event type can never leak the wrong offer.
 */
import { describe, expect, it } from "vitest";

import {
  buildKypNoShowDefinition,
  KYP_NOSHOW_LINK_100,
  KYP_NOSHOW_LINK_200
} from "../scripts/oneshot/kyp-noshow-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  BRANCH_ELSE_ARM,
  chooseBranchArm
} from "../supabase/functions/_shared/ai_flows/branching";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

type StepJson = {
  id?: string;
  type?: string;
  to?: string;
  body?: string;
  when?: Record<string, unknown>;
  steps?: StepJson[];
  branches?: Array<{ id?: string; steps?: StepJson[] }>;
  else?: StepJson[];
};

const definition = buildKypNoShowDefinition();
const steps = (definition as { steps?: StepJson[] }).steps ?? [];
const branch = steps.find((s) => s.type === "branch");

/** The lead-facing send_sms steps of one branch arm (or the else path). */
function armSends(armId: string): StepJson[] {
  const armSteps =
    armId === BRANCH_ELSE_ARM
      ? branch?.else ?? []
      : branch?.branches?.find((a) => a.id === armId)?.steps ?? [];
  return armSteps.filter((s) => s.type === "send_sms");
}

/** Which arm the REAL worker chooser picks for a booked event title. */
function armFor(eventTitle: string): string {
  expect(branch, "definition must route through a branch step").toBeDefined();
  return chooseBranchArm(branch as unknown as Extract<FlowStep, { type: "branch" }>, {
    vars: { event_title: eventTitle }
  });
}

describe("KYP no-show recovery definition (wrong-offer-link regression)", () => {
  it("still validates as a well-formed AiFlow definition", () => {
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("keeps the event_end no-show trigger and the 11am-6pm Toronto window", () => {
    const trigger = (definition as { trigger?: Record<string, unknown> }).trigger ?? {};
    expect(trigger.channel).toBe("calendar");
    expect(trigger.on).toBe("event_end");
    expect(trigger.followMinutes).toBe(120);
    expect((definition as { timeWindow?: unknown }).timeWindow).toEqual({
      timezone: "America/Toronto",
      start: "11:00",
      end: "18:00"
    });
  });

  it("extracts the booked event title so the branch has something to route on", () => {
    const extract = steps.find((s) => s.type === "extract_text") as
      | { fields?: Array<{ name?: string }> }
      | undefined;
    expect(extract?.fields?.map((f) => f.name)).toContain("event_title");
  });

  it("a '| 2' ($200) no-show is offered the $200 link — and never the $100 one", () => {
    const arm = armFor("KYP Ads | Free Strategy Call | 2");
    const sends = armSends(arm);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const send of sends) {
      expect(send.body).toContain(KYP_NOSHOW_LINK_200);
      expect(send.body).not.toContain(KYP_NOSHOW_LINK_100);
    }
  });

  it("a plain Free Strategy Call ($100) no-show is offered the $100 link — Tim's case", () => {
    const arm = armFor("KYP Ads | Free Strategy Call");
    const sends = armSends(arm);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const send of sends) {
      expect(send.body).toContain(KYP_NOSHOW_LINK_100);
      expect(send.body).not.toContain(KYP_NOSHOW_LINK_200);
    }
  });

  it("an unrecognized event type texts the lead NOTHING (owner follow-up only)", () => {
    const arm = armFor("KYP Ads | VIP Onboarding");
    expect(arm).toBe(BRANCH_ELSE_ARM);
    expect(armSends(arm)).toHaveLength(0);
    const ownerNotes = (branch?.else ?? []).filter((s) => s.type === "notify_owner");
    expect(ownerNotes.length).toBeGreaterThanOrEqual(1);
  });

  it("every lead-facing recovery text keeps the no-phone guard", () => {
    const allArms = [
      ...(branch?.branches ?? []).map((a) => a.steps ?? []),
      branch?.else ?? []
    ].flat();
    for (const send of allArms.filter((s) => s.type === "send_sms")) {
      expect(send.to).toBe("{{vars.invitee_phone}}");
      expect(send.when).toEqual({ var: "invitee_phone", notEquals: "none" });
    }
  });
});
