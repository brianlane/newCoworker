import { describe, expect, it } from "vitest";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * `broadcastAll` on route_to_team (team-first human handoff): offer EVERY
 * active, available roster member at once, the roster is resolved at
 * EXECUTION time, so the offer set never desyncs as employees come and go
 * (the fixed `agentNames` list would). Mutually exclusive with every
 * pinned-recipient option; the worker caps the fan-out at the same 10
 * recipients the agentNames schema bound allows.
 */

const routeStep = (over: Record<string, unknown> = {}) => ({
  id: "offer",
  type: "route_to_team",
  offerTemplate: "Customer needs a human, reply 1 to take it or 2 to pass.",
  responseMinutes: 10,
  ownerFallbackTemplate: "Nobody claimed the handoff.",
  ...over
});

const definition = (step: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "tag_changed", tag: "Needs Human", change: "added", conditions: [] },
  steps: [step]
});

describe("route_to_team broadcastAll, schema", () => {
  it("accepts broadcastAll: true on its own", () => {
    const def = parseAiFlowDefinition(definition(routeStep({ broadcastAll: true })));
    const step = def.steps[0] as { broadcastAll?: boolean };
    expect(step.broadcastAll).toBe(true);
  });

  it("rejects broadcastAll: false (only the literal true is meaningful)", () => {
    expect(() => parseAiFlowDefinition(definition(routeStep({ broadcastAll: false })))).toThrow();
  });

  it.each([
    ["agentName", { agentName: "Dania Shaikh" }],
    ["agentRef", { agentRef: { source: "employee", id: "00000000-0000-4000-8000-000000000001" } }],
    ["agentNames", { agentNames: ["Dania Shaikh", "Awais Chauhan"] }]
  ])("rejects broadcastAll alongside %s (offer sets would contradict)", (_label, pin) => {
    let thrown: unknown;
    try {
      parseAiFlowDefinition(definition(routeStep({ broadcastAll: true, ...pin })));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiFlowValidationError);
    expect((thrown as AiFlowValidationError).issues.join("\n")).toMatch(/broadcastAll/);
  });

  it("still accepts the existing modes untouched (regression guard)", () => {
    expect(() => parseAiFlowDefinition(definition(routeStep()))).not.toThrow();
    expect(() =>
      parseAiFlowDefinition(definition(routeStep({ agentNames: ["A B", "C D"] })))
    ).not.toThrow();
  });
});

describe("route_to_team broadcastAll, planner", () => {
  const scope = { vars: {}, trigger: { channel: "tag_changed", from: "+14165550100" } };

  it("carries broadcastAll: true into the action", () => {
    const plan = planStep(routeStep({ broadcastAll: true }) as FlowStep, scope);
    if (!plan.ok) throw new Error(plan.error);
    expect((plan.action as { broadcastAll?: boolean }).broadcastAll).toBe(true);
  });

  it("omits broadcastAll from the action when the step does not set it", () => {
    const plan = planStep(routeStep() as FlowStep, scope);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).not.toHaveProperty("broadcastAll");
  });
});

/**
 * The lead-type filter. Amy's rule is that a seller lead goes to the
 * teammates who cover sellers, and `broadcastAll` had no way to express that:
 * it was the whole roster or a hardcoded name list. The tag rides the SAME
 * selector as the notify_lead_owner team alert, so an offer and an alert can
 * never disagree about who covers what.
 */
describe("route_to_team teamTagTemplate", () => {
  const scope = {
    vars: { lead_type: "seller" },
    trigger: { channel: "tag_changed", from: "+14165550100" }
  };

  it("accepts a tag alongside broadcastAll", () => {
    const def = parseAiFlowDefinition(
      definition(routeStep({ broadcastAll: true, teamTagTemplate: "{{vars.lead_type}}" }))
    );
    const step = def.steps[0] as { teamTagTemplate?: string };
    expect(step.teamTagTemplate).toBe("{{vars.lead_type}}");
  });

  it("REJECTS a tag without broadcastAll", () => {
    // Narrowing an explicitly named list is a contradiction: the author
    // already said exactly who to offer, and dropping some of those names by
    // tag is a surprise no fail-safe can rescue.
    for (const over of [{}, { agentNames: ["A B", "C D"] }, { agentName: "A B" }]) {
      expect(() =>
        parseAiFlowDefinition(definition(routeStep({ ...over, teamTagTemplate: "seller" })))
      ).toThrow(AiFlowValidationError);
    }
  });

  it("renders the tag into the action from the lead's own vars", () => {
    const plan = planStep(
      routeStep({ broadcastAll: true, teamTagTemplate: "{{vars.lead_type}}" }) as FlowStep,
      scope
    );
    if (!plan.ok) throw new Error(plan.error);
    expect((plan.action as { teamTag?: string }).teamTag).toBe("seller");
  });

  it("carries a literal tag through unchanged", () => {
    const plan = planStep(
      routeStep({ broadcastAll: true, teamTagTemplate: "seller" }) as FlowStep,
      scope
    );
    if (!plan.ok) throw new Error(plan.error);
    expect((plan.action as { teamTag?: string }).teamTag).toBe("seller");
  });

  it("drops the tag when the template renders empty, which means NO filter", () => {
    // An all-empty render is "no filter", not "a tag nobody has": a template
    // pointing at an unset var must offer the whole roster, never nobody.
    const plan = planStep(
      routeStep({ broadcastAll: true, teamTagTemplate: "{{vars.missing}}" }) as FlowStep,
      { vars: {}, trigger: { channel: "tag_changed", from: "+14165550100" } }
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).not.toHaveProperty("teamTag");
  });

  it("omits teamTag from the action when the step sets no template", () => {
    const plan = planStep(routeStep({ broadcastAll: true }) as FlowStep, scope);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.action).not.toHaveProperty("teamTag");
  });
});
