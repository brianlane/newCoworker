import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";
import { buildSpokeCheckDefinition } from "../scripts/oneshot/clever-spoke-check-definition";

/**
 * The "Clever - Spoke Check & Weekly Call Follow-Up" definition the one-shot
 * seeds (Amy's weekly-call-until-reached routine) must validate through the
 * SAME parser the dashboard + CRUD API use — this is the CI tripwire that a
 * schema change can't silently break the seeded flow shape.
 */

const OPTS = {
  agentName: "Dave Lane",
  agentRef: {
    source: "employee" as const,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    label: "Dave Lane"
  },
  integrationLabel: "Clever",
  officeName: "Amy Laidlaw's office",
  attempts: 8
};

describe("buildSpokeCheckDefinition", () => {
  it("validates at the full 8 weekly attempts", () => {
    const def = parseAiFlowDefinition(buildSpokeCheckDefinition(OPTS));
    // trunk: read, recall, browse, sleep, route, call_1, 7 branches, goal, notify
    expect(def.steps).toHaveLength(15);
    expect(def.trigger.channel).toBe("owner_assigned");
    expect(def.timeWindow?.timezone).toBe("America/Phoenix");
  });

  it("validates at a single attempt (no weekly branches)", () => {
    const def = parseAiFlowDefinition(buildSpokeCheckDefinition({ ...OPTS, attempts: 1 }));
    expect(def.steps.filter((s) => s.type === "branch")).toHaveLength(0);
    expect(def.steps.filter((s) => s.type === "place_ai_call")).toHaveLength(1);
  });

  it("every call is gated, transfers to the agent ref, and shares one outcome var", () => {
    const def = parseAiFlowDefinition(buildSpokeCheckDefinition(OPTS)) as AiFlowDefinition;
    const calls: Array<Extract<AiFlowDefinition["steps"][number], { type: "place_ai_call" }>> = [];
    const walk = (steps: AiFlowDefinition["steps"]) => {
      for (const s of steps) {
        if (s.type === "place_ai_call") calls.push(s);
        if (s.type === "branch") {
          for (const arm of s.branches) walk(arm.steps);
          walk(s.else);
        }
      }
    };
    walk(def.steps);
    expect(calls).toHaveLength(8);
    for (const c of calls) {
      expect(c.saveAs).toBe("call_outcome");
      expect(c.toVar).toBe("lead_phone");
      expect(c.transfer?.toRef).toEqual(OPTS.agentRef);
      expect(c.notifyRef).toEqual(OPTS.agentRef);
      expect(c.transfer?.preSmsTemplate).toContain("LIVE TRANSFER coming");
      expect(c.personaTemplate).toContain("Amy Laidlaw's office");
      expect(c.personaTemplate).toContain("is now a good time");
    }
    // The trunk call is claim-gated; the weekly branches carry the claim gate
    // on the branch itself plus connected-call arms.
    const trunkCall = def.steps.find((s) => s.type === "place_ai_call");
    expect(trunkCall?.when).toEqual({ var: "claimed_agent", equals: "none" });
    const branches = def.steps.filter((s) => s.type === "branch");
    for (const b of branches) {
      expect(b.when).toEqual({ var: "claimed_agent", equals: "none" });
      expect(b.branches.map((a) => a.condition.equals)).toEqual(["transferred", "answered"]);
      expect(b.branches.every((a) => a.steps.length === 0)).toBe(true);
      expect(b.else.map((s) => s.type)).toEqual(["sleep", "place_ai_call"]);
    }
  });

  it("pins the spoke check to the agent with the 1/2 reply mechanic", () => {
    const def = parseAiFlowDefinition(buildSpokeCheckDefinition(OPTS)) as AiFlowDefinition;
    const route = def.steps.find((s) => s.type === "route_to_team");
    expect(route?.type === "route_to_team" && route.agentName).toBe("Dave Lane");
    expect(route?.type === "route_to_team" && route.offerTemplate).toContain(
      "Reply 1 = YES I spoke with them"
    );
    expect(route?.type === "route_to_team" && route.responseMinutes).toBe(1440);
  });
});
