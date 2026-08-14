import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  BROADCAST_NAMES,
  CASCADE_CLAUSE,
  FIRST_TO_CLAIM
} from "../scripts/oneshot/amy-broadcast-realtor-and-offer-copy";
import {
  BUYER_ARM_ID,
  BUYER_CONDITION,
  BUYER_ROUTE_ID,
  BUYER_TITLE,
  GATE_STEP_ID,
  PRICE_GATE,
  ROTATION_NAMES,
  SELLER_ROUTE_ID,
  SELLER_TITLE,
  patchRealtorBuyerRotation,
  toBuyerRotationCopy,
  toSellerBroadcastCopy
} from "../scripts/oneshot/amy-realtor-buyer-rotation";

/**
 * Brian, pointing at Carlos Gonzalez's run: "Why isn't Jason getting offered
 * this buyer lead too? Not simultaneously but round robin for buyer."
 *
 * He wasn't because the flow's single route step is a hardcoded broadcast to
 * the seller trio with no lead-type gate, so every Realtor.com lead, buyer
 * included, went to Gabrielle, Amy and Dave at once.
 */

const OFFER =
  `${BUYER_TITLE} {{vars.lead_name}} {{vars.lead_phone}}\n` +
  "ETA of when you can please triple tap? Thanks.\n" +
  "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
  "Lead source: Realtor.com (realtor.com)\n" +
  `${FIRST_TO_CLAIM}`;

type Step = Record<string, unknown>;

const def = (): { version: 1; trigger: unknown; steps: Step[] } => ({
  version: 1,
  trigger: { channel: "sms" as const, conditions: [{ type: "contains" as const, value: "rltr.pro" }] },
  steps: [
    {
      id: "s1",
      type: "extract_text",
      fields: [
        { name: "lead_name" },
        { name: "lead_phone" },
        { name: "price_gate" },
        { name: "lead_type" },
        { name: "price_under_1m" }
      ]
    },
    {
      id: SELLER_ROUTE_ID,
      type: "route_to_team",
      when: { ...PRICE_GATE },
      agentNames: [...BROADCAST_NAMES],
      responseMinutes: 10,
      ownerDirectWhen: { var: "price_under_1m", equals: "no" },
      ownerDirectTemplate: "HIGH-VALUE Realtor.com lead ($1M+) kept for you.",
      ownerDirectNudges: true,
      unclaimedReminders: { rounds: 3, intervalMinutes: 20, detailsTemplate: "Price: x" },
      offerTemplate: OFFER,
      ownerFallbackTemplate: "No agent claimed {{vars.lead_name}}"
    },
    {
      id: "rt_gated_tag",
      type: "update_contact",
      when: { var: "price_gate", equals: "ai" },
      phoneVar: "lead_phone",
      addTags: ["Needs Follow Up"]
    }
  ]
});

const gate = (d: { steps: Step[] }): Step => d.steps.find((s) => s.id === GATE_STEP_ID)!;
const buyerStep = (d: { steps: Step[] }): Step =>
  ((gate(d).branches as Array<{ steps: Step[] }>)[0]!.steps[0] as Step);
const sellerStep = (d: { steps: Step[] }): Step => (gate(d).else as Step[])[0]!;

describe("rotation copy", () => {
  /**
   * "or it goes to the next agent" is TRUE of a rotation and false of a
   * broadcast, and "first to reply 1 gets it" is the other way round. This
   * flow has twice shipped a routing change that left its wording behind.
   */
  it("adds the cascade clause and drops the first-to-claim line", () => {
    const out = toBuyerRotationCopy(OFFER);
    expect(out).toContain(CASCADE_CLAUSE);
    expect(out).not.toContain(FIRST_TO_CLAIM);
    expect(out).toContain("Lead source: Realtor.com (realtor.com)");
  });

  it("is idempotent", () => {
    const once = toBuyerRotationCopy(OFFER);
    expect(toBuyerRotationCopy(once)).toBe(once);
  });

  it("keeps calling a buyer lead a buyer lead", () => {
    expect(toBuyerRotationCopy(OFFER).startsWith(BUYER_TITLE)).toBe(true);
    expect(toBuyerRotationCopy(OFFER.replace(BUYER_TITLE, SELLER_TITLE)).startsWith(BUYER_TITLE)).toBe(
      true
    );
  });

  /**
   * Silently shipping a rotation offer with no cascade clause is exactly how
   * the copy drifts from the behavior again. Refuse instead.
   */
  it("refuses copy it cannot reword", () => {
    expect(() => toBuyerRotationCopy("Take this lead. Call them now.")).toThrow(/re-read the offer/);
  });
});

describe("broadcast copy", () => {
  it("keeps first-to-claim, no cascade, and stops saying buyer", () => {
    const out = toSellerBroadcastCopy(OFFER);
    expect(out).toContain(FIRST_TO_CLAIM);
    expect(out).not.toContain(CASCADE_CLAUSE);
    expect(out.startsWith(SELLER_TITLE)).toBe(true);
  });

  it("is idempotent", () => {
    const once = toSellerBroadcastCopy(OFFER);
    expect(toSellerBroadcastCopy(once)).toBe(once);
  });
});

describe("splitting the single route", () => {
  it("puts the gate where the route was, buyers in the arm, sellers in the else", () => {
    const d = def();
    const res = patchRealtorBuyerRotation(d);
    expect(res.changed).toBe(true);
    // The gate takes s4's trunk position, so the steps around it keep their order.
    expect(d.steps.map((s) => s.id)).toEqual(["s1", GATE_STEP_ID, "rt_gated_tag"]);
    const arm = (gate(d).branches as Array<{ id: string; condition: unknown }>)[0]!;
    expect(arm.id).toBe(BUYER_ARM_ID);
    expect(arm.condition).toEqual(BUYER_CONDITION);
    expect(buyerStep(d).id).toBe(BUYER_ROUTE_ID);
    expect(sellerStep(d).id).toBe(SELLER_ROUTE_ID);
  });

  /**
   * A rotation names nobody: the worker resolves the roster at execution time,
   * which is the only mechanism that puts Jason in the race at all.
   */
  it("makes the buyer step a rotation and leaves the seller broadcast alone", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    expect(buyerStep(d)).not.toHaveProperty("agentNames");
    expect(sellerStep(d).agentNames).toEqual(BROADCAST_NAMES);
  });

  /**
   * The under-$500K AI-owned gate outranks both paths, including when the
   * extraction contradicts itself (price_gate "ai" with lead_type "buyer"):
   * keeping the gate on BOTH steps is what makes that case offer nobody.
   */
  it("keeps the price gate on both routes", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    expect(buyerStep(d).when).toEqual(PRICE_GATE);
    expect(sellerStep(d).when).toEqual(PRICE_GATE);
  });

  /** The $1M+ keep-for-owner rule, the reminder ladder and the claim email
   * are cloned rather than re-authored, so the two paths cannot drift. */
  it("carries every other guard onto the rotation", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    const buyer = buyerStep(d);
    const seller = sellerStep(d);
    for (const key of [
      "ownerDirectWhen",
      "ownerDirectTemplate",
      "ownerDirectNudges",
      "unclaimedReminders",
      "responseMinutes",
      "ownerFallbackTemplate"
    ]) {
      expect(buyer[key]).toEqual(seller[key]);
    }
  });

  it("gives each path the copy its routing earns", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    expect(buyerStep(d).offerTemplate).toBe(toBuyerRotationCopy(OFFER));
    expect(sellerStep(d).offerTemplate).toBe(toSellerBroadcastCopy(OFFER));
  });

  it("stays a valid definition", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    const parsed = parseAiFlowDefinition(d);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("is a no-op on a second run", () => {
    const d = def();
    patchRealtorBuyerRotation(d);
    expect(patchRealtorBuyerRotation(d).changed).toBe(false);
  });

  /**
   * Every abort is "the routing moved underneath us". Splitting a step whose
   * meaning has changed is worse than doing nothing.
   */
  it("aborts when the route moved, changed type, lost the broadcast or lost the gate", () => {
    const gone = def();
    gone.steps = gone.steps.filter((s) => s.id !== SELLER_ROUTE_ID);
    expect(() => patchRealtorBuyerRotation(gone)).toThrow(/not at the trunk/);

    const wrongType = def();
    wrongType.steps[1]!.type = "notify_owner";
    expect(() => patchRealtorBuyerRotation(wrongType)).toThrow(/not a route/);

    const rotated = def();
    delete rotated.steps[1]!.agentNames;
    expect(() => patchRealtorBuyerRotation(rotated)).toThrow(/not the expected broadcast/);

    const renamed = def();
    renamed.steps[1]!.agentNames = ["Dave Lane", "Gabrielle Mota"];
    expect(() => patchRealtorBuyerRotation(renamed)).toThrow(/not the expected broadcast/);

    const ungated = def();
    delete ungated.steps[1]!.when;
    expect(() => patchRealtorBuyerRotation(ungated)).toThrow(/no longer carries the price_gate gate/);

    const noOffer = def();
    delete noOffer.steps[1]!.offerTemplate;
    expect(() => patchRealtorBuyerRotation(noOffer)).toThrow(/no offerTemplate/);
  });
});

describe("who the rotation reaches", () => {
  /**
   * Amy is deliberately absent: her roster row carries routing_enabled=false,
   * which keeps her out of the race and leaves her the owner fallback. The
   * rotation itself names nobody, so this list only backs the pre-flight.
   */
  it("is the buyer trio, and Jason is in it", () => {
    expect(ROTATION_NAMES).toContain("Jason Lane");
    expect(ROTATION_NAMES).not.toContain("Amy Laidlaw");
    expect(ROTATION_NAMES).toEqual(["Dave Lane", "Gabrielle Mota", "Jason Lane"]);
  });
});
