import { describe, expect, it } from "vitest";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * `broadcastAll` on route_to_team (team-first human handoff): offer EVERY
 * active, available roster member at once — the roster is resolved at
 * EXECUTION time, so the offer set never desyncs as employees come and go
 * (the fixed `agentNames` list would). Mutually exclusive with every
 * pinned-recipient option; the worker caps the fan-out at the same 10
 * recipients the agentNames schema bound allows.
 */

const routeStep = (over: Record<string, unknown> = {}) => ({
  id: "offer",
  type: "route_to_team",
  offerTemplate: "Customer needs a human — reply 1 to take it or 2 to pass.",
  responseMinutes: 10,
  ownerFallbackTemplate: "Nobody claimed the handoff.",
  ...over
});

const definition = (step: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "tag_changed", tag: "Needs Human", change: "added", conditions: [] },
  steps: [step]
});

describe("route_to_team broadcastAll — schema", () => {
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

describe("route_to_team broadcastAll — planner", () => {
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
