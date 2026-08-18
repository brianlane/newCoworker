import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  CALL_GATE,
  OWNER_DIRECT_GATE,
  PRICE_DIGITS_FIELD,
  UNDER_1M_VAR,
  assertNoBandGates,
  patchClever,
  patchRealtor,
  patchReferralExchange
} from "../scripts/oneshot/amy-deterministic-price-band";
import {
  patchClever as takeoverClever,
  patchRealtor as takeoverRealtor,
  patchReferralExchange as takeoverRe
} from "../scripts/oneshot/amy-team-unclaimed-ai-followup";
import { findStepDeep, type Definition } from "../scripts/oneshot/amy-under-500k-ai-owned";

/**
 * Fixtures mirror the LIVE flows as they stand BEFORE this patch: extracted
 * price_band still gating calls / owner-direct / the takeover arm. The
 * takeover branch is produced by the REAL takeover patcher run first, exactly
 * as production got it, so this patch's arm-rewiring is exercised against the
 * true shape rather than a hand-drawn copy.
 *
 * NOTE: the takeover helper now emits the COMPUTED arm for fresh applies, so
 * these fixtures re-point it back at price_band first, that is the state
 * production is in when this script runs.
 */

type Step = Record<string, unknown>;

function routeStep(id: string, extra: Step = {}): Step {
  return {
    id,
    type: "route_to_team",
    offerTemplate: "New lead: {{vars.lead_name}} ({{vars.lead_phone}})",
    ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}. It's back to you.",
    responseMinutes: 10,
    claimedNotifyEmail: "amy@amylaidlaw.com",
    ownerDirectWhen: { var: "price_band", equals: "over_1m" },
    ownerDirectTemplate: "HIGH-VALUE {{vars.lead_name}}",
    ...extra
  };
}

/** Re-point a fixture's takeover arm at price_band (production's state). */
function armOnExtractedBand(def: Definition, prefix: string): void {
  const branch = findStepDeep(def.steps, `${prefix}_team_unclaimed`)!;
  const arm = (branch.branches as Array<{ id: string; condition: unknown }>).find(
    (a) => a.id === `${prefix}_tu_open`
  )!;
  arm.condition = { var: "price_band", equals: "under_1m" };
}

function cleverFixture(): Definition {
  const def: Definition = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever referral" }] },
    steps: [
      {
        id: "read_details",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "price" },
          { name: "price_band" },
          { name: "price_gate" }
        ]
      },
      {
        id: "ai_call_1",
        type: "place_ai_call",
        toVar: "lead_phone",
        personaTemplate: "Hi {{vars.lead_name}}",
        notifyOwner: true,
        saveAs: "call_outcome",
        when: { var: "price_band", equals: "under_1m" }
      },
      routeStep("route", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "price_gate", notEquals: "ai" }
      })
    ]
  };
  takeoverClever(def);
  armOnExtractedBand(def, "clever");
  return def;
}

function reFixture(): Definition {
  const def: Definition = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "ReferralExchange" }] },
    steps: [
      {
        id: "browse",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "route_lead_type" },
          { name: "price_band" },
          { name: "price_gate" }
        ]
      },
      {
        id: "ai_first_contact",
        type: "branch",
        question: "Which script?",
        branches: [
          {
            id: "ai_call_seller_arm",
            label: "Seller",
            condition: { var: "route_lead_type", equals: "seller" },
            steps: [
              {
                id: "ai_call_seller",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Hi {{vars.lead_name}}",
                notifyOwner: true,
                saveAs: "call_outcome",
                when: { var: "price_band", equals: "under_1m" }
              }
            ]
          },
          {
            id: "ai_call_buyer_arm",
            label: "Buyer",
            condition: { var: "route_lead_type", equals: "buyer" },
            steps: [
              {
                id: "ai_call_buyer",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Hi {{vars.lead_name}}",
                notifyOwner: true,
                saveAs: "call_outcome",
                when: { var: "price_band", equals: "under_1m" }
              }
            ]
          },
          {
            id: "ai_call_both_arm",
            label: "Both",
            condition: { var: "route_lead_type", equals: "both" },
            steps: [
              {
                id: "ai_call_both",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Hi {{vars.lead_name}}",
                notifyOwner: true,
                saveAs: "call_outcome",
                when: { var: "price_band", equals: "under_1m" }
              }
            ]
          }
        ],
        else: []
      },
      routeStep("route_buyer", { when: { var: "route_lead_type", equals: "buyer" } }),
      routeStep("route_seller", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_lead_type", equals: "seller" }
      }),
      routeStep("route_both", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_lead_type", equals: "both" }
      })
    ]
  };
  takeoverRe(def);
  armOnExtractedBand(def, "re");
  return def;
}

function realtorFixture(): Definition {
  const def: Definition = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "rltr.pro" }] },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "price_band" },
          { name: "price_gate" }
        ]
      },
      routeStep("s4", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "price_gate", notEquals: "ai" }
      })
    ]
  };
  takeoverRealtor(def);
  armOnExtractedBand(def, "rt");
  return def;
}

function validate(def: Definition): void {
  const parsed = parseAiFlowDefinition(def);
  expect(validateDefinitionSemantics(parsed)).toEqual([]);
}

describe("the gate shapes and their fail-safe directions", () => {
  it("calls fail toward calling; owner-direct demands a proven $1M+", () => {
    // "yes", "not_a_number", and a missing producer all keep the call.
    expect(CALL_GATE).toEqual({ var: UNDER_1M_VAR, notEquals: "no" });
    // Only an arithmetic "no" (price_digits >= 1000000) keeps a lead from
    // the team.
    expect(OWNER_DIRECT_GATE).toEqual({ var: UNDER_1M_VAR, equals: "no" });
  });

  it("price_digits reads 0 for a missing price, which computes to under", () => {
    expect(PRICE_DIGITS_FIELD.description).toContain("answer exactly: 0");
  });
});

describe("Clever", () => {
  it("adds digits + math, rewires call, owner-direct and takeover arm, validates", () => {
    const def = cleverFixture();
    const { changed, notes } = patchClever(def);
    expect(changed).toBe(true);
    expect(notes.join(" ")).toContain("computed");
    // The math step sits right after the reader so every later gate has it.
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids.indexOf("clever_price_lt_1m")).toBe(ids.indexOf("read_details") + 1);
    expect(findStepDeep(def.steps, "ai_call_1")!.when).toEqual(CALL_GATE);
    expect(findStepDeep(def.steps, "route")!.ownerDirectWhen).toEqual(OWNER_DIRECT_GATE);
    const arm = (
      findStepDeep(def.steps, "clever_team_unclaimed") as {
        branches: Array<{ condition: unknown }>;
      }
    ).branches[0];
    expect(arm.condition).toEqual({ var: UNDER_1M_VAR, notEquals: "no" });
    assertNoBandGates(def, "Clever");
    validate(def);
    expect(patchClever(def).changed).toBe(false);
  });

  it("refuses an unexpected guard instead of overwriting it", () => {
    const def = cleverFixture();
    findStepDeep(def.steps, "ai_call_1")!.when = { var: "something", equals: "x" };
    expect(() => patchClever(def)).toThrow(/unexpected when guard/);
  });
});

describe("ReferralExchange", () => {
  it("rewires all three call gates and all three owner-directs, validates", () => {
    const def = reFixture();
    expect(patchReferralExchange(def).changed).toBe(true);
    for (const id of ["ai_call_buyer", "ai_call_seller", "ai_call_both"]) {
      expect(findStepDeep(def.steps, id)!.when).toEqual(CALL_GATE);
    }
    for (const id of ["route_buyer", "route_seller", "route_both"]) {
      expect(findStepDeep(def.steps, id)!.ownerDirectWhen).toEqual(OWNER_DIRECT_GATE);
    }
    assertNoBandGates(def, "RE");
    validate(def);
    expect(patchReferralExchange(def).changed).toBe(false);
  });
});

describe("Realtor.com", () => {
  it("has no call to rewire; owner-direct and takeover arm move, validates", () => {
    const def = realtorFixture();
    expect(patchRealtor(def).changed).toBe(true);
    expect(findStepDeep(def.steps, "s4")!.ownerDirectWhen).toEqual(OWNER_DIRECT_GATE);
    assertNoBandGates(def, "Realtor");
    validate(def);
    expect(patchRealtor(def).changed).toBe(false);
  });
});

describe("assertNoBandGates", () => {
  it("catches a straggler price_band gate anywhere in the tree", () => {
    const def = cleverFixture();
    patchClever(def);
    (def.steps ?? []).push({
      id: "straggler",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: "x",
      when: { var: "price_band", equals: "under_1m" }
    });
    expect(() => assertNoBandGates(def, "Clever")).toThrow(/price_band still gates/);
  });
});
