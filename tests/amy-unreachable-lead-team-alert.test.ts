import { describe, expect, it } from "vitest";
import {
  PLANS,
  alertMessage,
  noPhoneGuard,
  patchFlow
} from "../scripts/oneshot/amy-unreachable-lead-team-alert";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { Definition } from "../scripts/oneshot/amy-under-500k-ai-owned";

/**
 * A lead arriving with no phone used to disappear: every downstream step keys
 * on `lead_phone`, so contact creation, the AI call, and the cadence-enrolment
 * tag all no-opped and the run finished "done" with nobody told. These pin the
 * guard that closes it.
 */

/**
 * What each live flow's extracting step actually declares, transcribed from
 * the definitions on 2026-08-15.
 *
 * Hardcoded rather than derived from the plan, on purpose: the validator
 * rejects a template that uses a var no earlier step produces, so this is what
 * makes "the alert copy only references vars this flow really has" a real
 * assertion instead of a fixture agreeing with itself.
 */
const DECLARED: Record<string, string[]> = {
  "Clever Lead - Accept": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "price",
    "lead_url"
  ],
  "ReferralExchange Lead": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "location",
    "price",
    "lead_type"
  ],
  "Realtor.com Lead": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "lead_price_details",
    "lead_url",
    "lead_type"
  ],
  "New Lead Intake": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "price",
    "lead_details",
    "lead_type"
  ]
};

/** The smallest definition the schema accepts, with the anchor step present. */
const baseDef = (anchorId: string, vars: string[] = ["lead_phone"]): Definition =>
  ({
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
    steps: [
      {
        id: anchorId,
        type: "extract_text",
        fields: vars.map((name) => ({ name, description: `the lead's ${name}` }))
      },
      { id: "later", type: "notify_owner", message: "done" }
    ]
  }) as unknown as Definition;

/** Just enough shape to assert on; the builder returns a plain step object. */
type Guard = {
  branches: Array<{ condition: Record<string, string>; steps: unknown[] }>;
  else: Array<{ type: string; unownedFallback?: string; teamTagTemplate?: string }>;
};

describe("the no-phone guard", () => {
  it("gates on a usable E.164 number, alerting on the else arm", () => {
    // `whenSchema` forbids an empty needle, so "is this blank" is unaskable.
    // Every number these flows can use is E.164, so the "+" is the test.
    const guard = noPhoneGuard(PLANS[0]) as unknown as Guard;
    expect(guard.branches[0].condition).toEqual({ var: "lead_phone", contains: "+" });
    expect(guard.branches[0].steps).toEqual([]);
    expect(guard.else[0].type).toBe("notify_lead_owner");
  });

  it("alerts the TEAM, not just the owner", () => {
    const alert = (noPhoneGuard(PLANS[0]) as unknown as Guard).else[0];
    expect(alert.unownedFallback).toBe("team");
    expect(alert.teamTagTemplate).toBe("seller");
  });

  it("narrows to the lead type wherever the flow knows it", () => {
    // Clever's accept flow is the Clever Offers seller path end to end and has
    // no lead-type var, so it carries the literal instead of a template.
    const byFlow = Object.fromEntries(PLANS.map((p) => [p.flow, p.teamTag]));
    expect(byFlow["Clever Lead - Accept"]).toBe("seller");
    // NOT route_lead_type: that var answers "none" exactly when this guard
    // fires (no phone option), so it would match nobody every time.
    expect(byFlow["ReferralExchange Lead"]).toBe("{{vars.lead_type}}");
    expect(byFlow["Realtor.com Lead"]).toBe("{{vars.lead_type}}");
    expect(byFlow["New Lead Intake"]).toBe("{{vars.lead_type}}");
  });

  it("says what the AI cannot do and who has to act", () => {
    const msg = alertMessage(PLANS[0]);
    expect(msg).toContain("NO phone number");
    expect(msg).toContain("nobody owns the lead");
    expect(msg).toContain("reach out by hand");
    // Not an offer: no claim affordance, no deadline.
    expect(msg).not.toMatch(/reply\s*\*?1\*?/i);
  });

  it("carries no em dashes in any flow's copy", () => {
    for (const plan of PLANS) expect(alertMessage(plan)).not.toContain("—");
  });

  it("stays inside the notify_lead_owner 1000-character cap", () => {
    for (const plan of PLANS) expect(alertMessage(plan).length).toBeLessThanOrEqual(1000);
  });
});

describe("patchFlow", () => {
  it("inserts the guard immediately after the extracting step", () => {
    const def = baseDef("parse");
    const res = patchFlow(def, { ...PLANS[3], after: "parse" });
    expect(res.changed).toBe(true);
    expect(def.steps!.map((s) => (s as { id: string }).id)).toEqual([
      "parse",
      "nli_no_phone_guard",
      "later"
    ]);
  });

  it("is purely additive: it removes and rewrites nothing", () => {
    // ReferralExchange and New Lead Intake already page the OWNER on a missing
    // phone. Replacing that would take away a notice Amy gets today.
    const def = baseDef("parse");
    const before = JSON.parse(JSON.stringify(def.steps));
    patchFlow(def, { ...PLANS[3], after: "parse" });
    const after = def.steps!.filter((s) => (s as { id: string }).id !== "nli_no_phone_guard");
    expect(after).toEqual(before);
  });

  it("is idempotent", () => {
    const def = baseDef("parse");
    patchFlow(def, { ...PLANS[3], after: "parse" });
    const once = JSON.parse(JSON.stringify(def));
    const second = patchFlow(def, { ...PLANS[3], after: "parse" });
    expect(second.changed).toBe(false);
    expect(def).toEqual(once);
  });

  it("never tags on a var that is blank exactly when the guard fires", () => {
    // ReferralExchange's `route_lead_type` is a REACHABILITY gate: its field
    // description answers "none" when the lead has no phone option, which is
    // precisely and only when this guard runs. Tagging on it would match
    // nobody every time and the fail-safe would silently widen every alert to
    // the whole roster. Caught by Bugbot on PR #1398.
    for (const plan of PLANS) {
      expect(plan.teamTag, plan.flow).not.toContain("route_lead_type");
      expect(plan.teamTag, plan.flow).not.toContain("sms_lead_type");
      expect(plan.teamTag, plan.flow).not.toContain("email_intro_type");
    }
  });

  it("converges an already-installed guard whose tag went stale", () => {
    // A re-run must FIX a wrong tag in place. Reverting a live flow just to
    // reinstall the guard is the alternative, and it is a worse one.
    const def = baseDef("browse", DECLARED["ReferralExchange Lead"]);
    patchFlow(def, { ...PLANS[1], teamTag: "{{vars.route_lead_type}}" });
    const res = patchFlow(def, PLANS[1]);
    expect(res.changed).toBe(true);
    expect(res.notes.join(" ")).toContain("team tag");
    const guard = def.steps!.find(
      (s) => (s as { id: string }).id === "re_no_phone_guard"
    ) as unknown as Guard;
    expect(guard.else[0].teamTagTemplate).toBe("{{vars.lead_type}}");
  });

  it("refuses to guess when the anchor step is gone", () => {
    // Step ids are never renamed on a live flow, so a missing anchor means the
    // flow is not the shape this patch was written against.
    const def = baseDef("something_else");
    expect(() => patchFlow(def, { ...PLANS[0], after: "read_details" })).toThrow(
      /expected a top-level step "read_details"/
    );
  });

  it("only references vars the flow really produces, for every flow", () => {
    // The validator rejects `{{vars.x}}` when no earlier step produces x, so
    // this catches a copy edit that reaches for a var the flow does not have.
    for (const plan of PLANS) {
      const def = baseDef(plan.after, DECLARED[plan.flow]);
      patchFlow(def, plan);
      expect(() => parseAiFlowDefinition(def), plan.flow).not.toThrow();
    }
  });

  it("every flow in PLANS has its vocabulary transcribed here", () => {
    expect(Object.keys(DECLARED).sort()).toEqual(PLANS.map((p) => p.flow).sort());
  });
});
