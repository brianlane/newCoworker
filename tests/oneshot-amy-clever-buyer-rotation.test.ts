/**
 * Clever buyers go round the buyer rotation
 * (scripts/oneshot/amy-clever-buyer-rotation.ts).
 *
 * Two things were left after the AI call was gated for buyers: every Clever
 * lead was still offered to the pinned seller trio, so Jason Lane (roster tag
 * `buyer` only) never saw one; and the offer copy promised follow-up that will
 * now never happen for a buyer, which invites a teammate to leave the lead
 * alone believing the AI has it.
 *
 * The fork mirrors `rt_route_gate` in "Realtor.com Lead" rather than inventing
 * a second shape for the same decision.
 */
import { describe, expect, it } from "vitest";
import {
  BUYER_ROUTE_STEP_ID,
  NO_AI_FOLLOW_UP_LINE,
  ROUTE_GATE_STEP_ID,
  SELLER_ROUTE_STEP_ID,
  alreadyPatched,
  buyerRouteStep,
  patchBuyerRotation,
  revertBuyerRotation
} from "../scripts/oneshot/amy-clever-buyer-rotation";
import { walkSteps } from "../scripts/oneshot/amy-clever-lead-type";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

type Step = Record<string, unknown> & { id: string; type: string };
type Def = { version: number; trigger: unknown; steps: Step[] };

/** The live seller route's shape at the points this fork depends on. */
function sellerRoute(): Step {
  return {
    id: SELLER_ROUTE_STEP_ID,
    type: "route_to_team",
    when: { var: "price_gate", notEquals: "ai" },
    agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
    offerTemplate:
      "New Clever lead: {{vars.lead_name}}\n" +
      "Next, unless you take it: the AI calls again in about 2 hours.",
    ownerDirectWhen: { var: "price_under_1m", equals: "no" },
    ownerDirectTemplate: "HIGH DOLLAR CLEVER LEAD",
    responseMinutes: 10,
    ownerFallbackTemplate: "No agent claimed the Clever lead {{vars.lead_name}}"
  };
}

function fixture(): Def {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "url" },
      // A browse step that CAPTURES, because the live flow does and the buyer
      // route keeps the seller route's `attachScreenshot`. The validator wants
      // an earlier browse step with `screenshot: true` specifically, so a
      // browse step without it would not model the live flow at all.
      {
        id: "read_details",
        type: "browse_extract",
        urlVar: "url",
        screenshot: true,
        fields: [
          { name: "lead_type", description: "buyer or seller" },
          { name: "lead_name", description: "name" },
          { name: "lead_phone", description: "phone" },
          { name: "lead_email", description: "email" },
          { name: "lead_address", description: "address" },
          { name: "price_gate", description: "team or ai" },
          { name: "price_digits", description: "digits" }
        ]
      },
      {
        id: "clever_price_lt_1m",
        type: "math",
        operation: "less_than",
        left: "{{vars.price_digits}}",
        right: "1000000",
        saveAs: "price_under_1m"
      },
      sellerRoute(),
      { id: "after_route", type: "notify_owner", message: "done" }
    ]
  };
}

describe("buyerRouteStep", () => {
  it("is UNPINNED, which is what the rotation is on this engine", () => {
    // agentNames is the broadcast: a named list sharing one deadline. Absent
    // means offered to one teammate at a time, in rotation order, which is
    // how buyers reach the team on this account.
    const step = buyerRouteStep();
    expect(step.agentNames).toBeUndefined();
    expect(step.broadcastAll).toBeUndefined();
    expect(step.agentName).toBeUndefined();
  });

  it("says the AI is not following this one up, and why", () => {
    // The whole point of the copy change. A teammate reading the seller offer
    // is told the AI calls again in two hours; for a buyer nothing does.
    expect(NO_AI_FOLLOW_UP_LINE).toContain("not on AI follow-up");
    expect(String(buyerRouteStep().offerTemplate)).toContain(NO_AI_FOLLOW_UP_LINE);
    // And every other team-facing template says it too, so the fact survives
    // whichever notice a teammate actually reads.
    expect(String(buyerRouteStep().claimedNotifyTemplate)).toContain("not on AI follow-up");
    expect(String(buyerRouteStep().ownerFallbackTemplate)).toContain("not on AI follow-up");
    expect(String(buyerRouteStep().ownerDirectTemplate)).toContain("not on AI follow-up");
  });

  it("uses rotation wording, not broadcast wording", () => {
    // "First to reply 1 gets it" belongs to a broadcast. A rotation hands on.
    const offer = String(buyerRouteStep().offerTemplate);
    expect(offer).toContain("it goes to the next agent");
    expect(offer).not.toContain("First to reply");
  });

  it("labels the address for someone who is buying", () => {
    // "Address:" reads as the property being listed. A buyer has none.
    expect(String(buyerRouteStep().offerTemplate)).toContain("Looking in:");
    expect(String(buyerRouteStep().offerTemplate)).not.toContain("Address:");
  });

  it("keeps the $1M+ rule, which is a price rule and not a seller rule", () => {
    expect(buyerRouteStep().ownerDirectWhen).toEqual({ var: "price_under_1m", equals: "no" });
    expect(buyerRouteStep().when).toEqual({ var: "price_gate", notEquals: "ai" });
  });

  it("carries no em dash in any team-facing copy", () => {
    const step = buyerRouteStep();
    for (const key of [
      "offerTemplate",
      "ownerDirectTemplate",
      "claimedNotifyTemplate",
      "ownerFallbackTemplate"
    ]) {
      expect(String(step[key])).not.toContain("—");
    }
  });
});

describe("patchBuyerRotation", () => {
  it("forks on lead_type, buyer to the rotation and everyone else to the trio", () => {
    const def = fixture();
    const { changed, problems } = patchBuyerRotation(def);
    expect(problems).toEqual([]);
    expect(changed).toHaveLength(2);

    const gate = def.steps.find((s) => s.id === ROUTE_GATE_STEP_ID)!;
    expect(gate.type).toBe("branch");
    const arms = gate.branches as Array<{ condition: unknown; steps: Step[] }>;
    expect(arms[0].condition).toEqual({ var: "lead_type", equals: "buyer" });
    expect(arms[0].steps.map((s) => s.id)).toEqual([BUYER_ROUTE_STEP_ID]);
    expect((gate.else as Step[]).map((s) => s.id)).toEqual([SELLER_ROUTE_STEP_ID]);
  });

  it("moves the seller route in UNTOUCHED, since sellers are 116 of 119", () => {
    const def = fixture();
    patchBuyerRotation(def);
    const gate = def.steps.find((s) => s.id === ROUTE_GATE_STEP_ID)!;
    expect((gate.else as Step[])[0]).toEqual(sellerRoute());
    // And it exists exactly once: a fork, not a copy.
    expect(walkSteps(def.steps).filter((s) => s.id === SELLER_ROUTE_STEP_ID)).toHaveLength(1);
  });

  it("puts the gate where the route was, so later steps still follow it", () => {
    const def = fixture();
    patchBuyerRotation(def);
    const ids = def.steps.map((s) => s.id);
    expect(ids.indexOf("clever_price_lt_1m")).toBeLessThan(ids.indexOf(ROUTE_GATE_STEP_ID));
    expect(ids.indexOf(ROUTE_GATE_STEP_ID)).toBeLessThan(ids.indexOf("after_route"));
  });

  it("carries no `when` on the branch, so each route keeps its own price gate", () => {
    // Mirrors rt_route_gate: hoisting the guard onto the branch would work,
    // but leaving it on each route keeps the two flows describing the same
    // decision the same way.
    const def = fixture();
    patchBuyerRotation(def);
    const gate = def.steps.find((s) => s.id === ROUTE_GATE_STEP_ID)!;
    expect(gate.when).toBeUndefined();
    const buyer = walkSteps(def.steps).find((s) => s.id === BUYER_ROUTE_STEP_ID)!;
    expect(buyer.when).toEqual({ var: "price_gate", notEquals: "ai" });
  });

  it("produces a definition the schema accepts", () => {
    // Fixture first, so a gap in it cannot read as a bug in the patch.
    expect(() => parseAiFlowDefinition(fixture())).not.toThrow();
    const def = fixture();
    patchBuyerRotation(def);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent and round-trips through revert", () => {
    const def = fixture();
    const before = JSON.parse(JSON.stringify(def));
    patchBuyerRotation(def);
    expect(alreadyPatched(def)).toBe(true);
    expect(patchBuyerRotation(def).changed).toEqual([]);
    expect(revertBuyerRotation(def)).toHaveLength(1);
    expect(def).toEqual(before);
    expect(revertBuyerRotation(def)).toEqual([]);
  });

  it("REFUSES rather than half-patching when the live shape has moved", () => {
    const noRoute = fixture();
    noRoute.steps = noRoute.steps.filter((s) => s.id !== SELLER_ROUTE_STEP_ID);
    expect(patchBuyerRotation(noRoute).problems[0]).toContain("is missing from the flow");

    const nested = fixture();
    const route = nested.steps.find((s) => s.id === SELLER_ROUTE_STEP_ID)!;
    nested.steps = nested.steps.filter((s) => s.id !== SELLER_ROUTE_STEP_ID);
    nested.steps.push({ id: "wrap", type: "branch", question: "q", branches: [], else: [route] });
    expect(patchBuyerRotation(nested).problems[0]).toContain("no longer a trunk step");

    // Already unpinned: forking buyers to "the rotation" would change nothing,
    // so say so rather than adding a branch that does no work.
    const unpinned = fixture();
    delete unpinned.steps.find((s) => s.id === SELLER_ROUTE_STEP_ID)!.agentNames;
    expect(patchBuyerRotation(unpinned).problems[0]).toContain("no longer pins agentNames");

    expect(patchBuyerRotation({ steps: null }).problems).toEqual([
      "definition has no steps array"
    ]);
  });
});
