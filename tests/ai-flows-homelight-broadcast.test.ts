import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  patchRouteToBroadcast,
  patchToAgentSmsToClaimer
} from "../scripts/oneshot/homelight-broadcast-offer";

/**
 * The one-shot that flips Amy's "HomeLight Referral" flow from Dave-only to a
 * simultaneous Amy + Dave broadcast. The helpers are pure; this pins their
 * edits, their idempotency, and that the patched shape of the LIVE flow
 * still validates.
 */

const DAVE = "Dave Lane";
const AMY = "Amy Laidlaw";

/** A faithful (trimmed) replica of Amy's live HomeLight Referral definition. */
function liveShape(): Record<string, unknown> & { steps: Record<string, unknown>[] } {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "has_url" },
        { type: "contains", value: "HomeLight Referral", caseInsensitive: true }
      ]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "alert",
        type: "extract_text",
        fields: [
          { name: "lead_first_name", description: "first name" },
          { name: "price", description: "price" },
          { name: "city", description: "city" },
          { name: "lead_type", description: "buyer or seller" },
          { name: "price_band", description: "over_1m or under_1m" }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        agentName: DAVE,
        responseMinutes: 5,
        offerTemplate:
          "New HomeLight referral: {{vars.lead_first_name}} — {{vars.lead_type}} in " +
          "{{vars.city}} (~{{vars.price}}).\nReply 1 to claim or 2 to pass by {{offer.deadline}}.",
        ownerFallbackTemplate:
          "Dave didn't claim the HomeLight referral {{vars.lead_first_name}} " +
          "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}) in time — it's back to you.",
        claimedNotifyTemplate: "{{agent.name}} claimed the HomeLight referral.",
        ownerDirectWhen: { var: "price_band", equals: "over_1m" },
        ownerDirectTemplate: "HIGH-VALUE kept for you",
        ownerDirectNudges: true
      },
      {
        id: "to_agent",
        type: "send_sms",
        toAgentName: DAVE,
        body: "HomeLight lead is yours: {{vars.lead_first_name}}",
        when: { var: "claimed_agent", notEquals: "none" }
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

describe("patchRouteToBroadcast", () => {
  it("swaps the Dave pin for the [Dave, Amy] broadcast, cues first-to-claim, and rewords the fallback", () => {
    const def = liveShape();
    expect(patchRouteToBroadcast(def, DAVE, AMY)).toBe(true);
    const route = def.steps.find((s) => s.id === "route")!;
    expect(route.agentName).toBeUndefined();
    expect(route.agentNames).toEqual([DAVE, AMY]);
    expect(route.offerTemplate).toMatch(/First to reply 1 gets it\.$/);
    expect(route.ownerFallbackTemplate).toMatch(/^No one claimed the HomeLight referral/);
    // The $1M+ keep-for-owner rule is untouched.
    expect(route.ownerDirectWhen).toEqual({ var: "price_band", equals: "over_1m" });
    expect(route.ownerDirectNudges).toBe(true);
  });

  it("is idempotent (second run changes nothing)", () => {
    const def = liveShape();
    patchRouteToBroadcast(def, DAVE, AMY);
    const once = JSON.stringify(def);
    expect(patchRouteToBroadcast(def, DAVE, AMY)).toBe(false);
    expect(JSON.stringify(def)).toBe(once);
  });

  it("leaves a route step pinned to somebody else alone", () => {
    const def = liveShape();
    (def.steps.find((s) => s.id === "route")! as { agentName?: string }).agentName =
      "Gabrielle Mota";
    expect(patchRouteToBroadcast(def, DAVE, AMY)).toBe(false);
  });

  it("no-ops on a definition without steps", () => {
    expect(patchRouteToBroadcast({}, DAVE, AMY)).toBe(false);
  });
});

describe("patchToAgentSmsToClaimer", () => {
  it("re-addresses the Dave-pinned contact-card SMS to the claimer", () => {
    const def = liveShape();
    expect(patchToAgentSmsToClaimer(def, DAVE)).toBe(true);
    const sms = def.steps.find((s) => s.id === "to_agent")!;
    expect(sms.toAgentName).toBeUndefined();
    expect(sms.to).toBe("{{vars.claimed_agent_phone}}");
  });

  it("is idempotent and skips SMS steps pinned to other people", () => {
    const def = liveShape();
    patchToAgentSmsToClaimer(def, DAVE);
    expect(patchToAgentSmsToClaimer(def, DAVE)).toBe(false);
    const other = liveShape();
    (other.steps.find((s) => s.id === "to_agent")! as { toAgentName?: string }).toAgentName =
      "Gabrielle Mota";
    expect(patchToAgentSmsToClaimer(other, DAVE)).toBe(false);
  });
});

describe("the fully patched flow still validates", () => {
  it("parseAiFlowDefinition accepts the patched live shape", () => {
    const def = liveShape();
    patchRouteToBroadcast(def, DAVE, AMY);
    patchToAgentSmsToClaimer(def, DAVE);
    const parsed = parseAiFlowDefinition(def);
    expect(parsed.steps.find((s) => s.id === "route")).toMatchObject({
      agentNames: [DAVE, AMY]
    });
  });
});
