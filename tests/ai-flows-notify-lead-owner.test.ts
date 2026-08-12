import { describe, expect, it } from "vitest";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * notify_lead_owner's unowned fallback.
 *
 * Amy's rule: a lead who comes back is told to the teammate who owns them, and
 * broadcast to the team when nobody does. The step resolved the owner at run
 * time already; what it lacked was any way to reach the TEAM when there wasn't
 * one, so an unowned lead's reply went to the business owner instead.
 */

const defWith = (step: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [] },
  steps: [
    { id: "x", type: "extract_text", fields: [{ name: "lead_phone" }, { name: "route_lead_type" }] },
    { id: "n", type: "notify_lead_owner", message: "They replied", ...step }
  ]
});

const issuesOf = (input: unknown): string[] => {
  try {
    parseAiFlowDefinition(input);
    return [];
  } catch (e) {
    if (e instanceof AiFlowValidationError) return e.issues;
    throw e;
  }
};

describe("schema", () => {
  it("accepts a team fallback with a templated tag", () => {
    expect(
      issuesOf(
        defWith({
          phoneVar: "lead_phone",
          unownedFallback: "team",
          teamTagTemplate: "{{vars.route_lead_type}}"
        })
      )
    ).toEqual([]);
  });

  // The tag template is an ordinary template, so a var no earlier step
  // produces has to be caught at author time like any other.
  it("scope-checks the tag template", () => {
    expect(
      issuesOf(defWith({ unownedFallback: "team", teamTagTemplate: "{{vars.lead_typo}}" })).some(
        (i) => i.includes("{{vars.lead_typo}} before any step produces it")
      )
    ).toBe(true);
  });

  it("rejects a fallback it does not know", () => {
    expect(issuesOf(defWith({ unownedFallback: "everyone" })).length).toBeGreaterThan(0);
  });

  // Absence is the off switch, and the off state is the historical behavior.
  it("accepts the step with no fallback at all", () => {
    expect(issuesOf(defWith({ phoneVar: "lead_phone" }))).toEqual([]);
  });
});

describe("planStep", () => {
  const plan = (step: Record<string, unknown>, vars: Record<string, string>) =>
    planStep({ id: "n", type: "notify_lead_owner", message: "They replied", ...step } as unknown as FlowStep, {
      vars
    });

  it("renders the tag from run vars", () => {
    const p = plan({ unownedFallback: "team", teamTagTemplate: "{{vars.route_lead_type}}" }, {
      route_lead_type: "buyer"
    });
    expect(p.ok && p.action.kind === "notify_lead_owner" ? p.action : null).toMatchObject({
      unownedFallback: "team",
      teamTag: "buyer"
    });
  });

  /**
   * An all-empty render means "no filter", not "a tag nobody has". The whole
   * point of the fallback is that a bad filter costs noise, never silence.
   */
  it("drops a tag that rendered empty", () => {
    const p = plan({ unownedFallback: "team", teamTagTemplate: "{{vars.route_lead_type}}" }, {});
    expect(p.ok && p.action.kind === "notify_lead_owner" && "teamTag" in p.action).toBe(false);
  });

  it("carries nothing extra when no fallback was configured", () => {
    const p = plan({}, {});
    const action = p.ok && p.action.kind === "notify_lead_owner" ? p.action : null;
    expect(action).toBeTruthy();
    expect(action && "unownedFallback" in action).toBe(false);
  });
});
