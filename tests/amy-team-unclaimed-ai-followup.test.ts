import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  FALLBACK_TAKEOVER_LINE,
  REALTOR_LEAD_TYPE_FIELD,
  patchClever,
  patchNewLeadIntake,
  patchRealtor,
  patchReferralExchange,
  teamUnclaimedBranch
} from "../scripts/oneshot/amy-team-unclaimed-ai-followup";
import { findStepDeep, type Definition } from "../scripts/oneshot/amy-under-500k-ai-owned";
import { AUTO_TAG_NOTE, FOLLOW_UP_TAG } from "../scripts/oneshot/amy-needs-follow-up-definition";

/**
 * Fixtures mirror the LIVE post-gate flows (price_gate already extracted,
 * routes already gated) and are complete enough that the PATCHED result must
 * pass parseAiFlowDefinition: the applier refuses to write an invalid
 * definition, so a fixture that cannot validate would hide a structural bug
 * until apply time.
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
    ...extra
  };
}

function cleverFixture(): Definition {
  return {
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
}

function reFixture(): Definition {
  return {
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
}

function realtorFixture(): Definition {
  return {
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
}

function nliFixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "manual" },
    steps: [
      {
        id: "parse",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "price_band" },
          { name: "price_gate" },
          { name: "route_variant" }
        ]
      },
      routeStep("route_seller", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_variant", equals: "seller" }
      }),
      routeStep("route_both", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_variant", equals: "both" }
      })
    ]
  };
}

function validate(def: Definition): void {
  const parsed = parseAiFlowDefinition(def);
  expect(validateDefinitionSemantics(parsed)).toEqual([]);
}

describe("the takeover branch shape", () => {
  const tagStep = {
    id: "x_tag",
    type: "update_contact",
    phoneVar: "lead_phone",
    addTags: [FOLLOW_UP_TAG]
  };
  const withType = teamUnclaimedBranch("x", [
    { suffix: "_s", condition: { var: "route_lead_type", equals: "seller" }, tagSteps: [tagStep] }
  ]) as {
    when: unknown;
    branches: Array<{ condition: unknown; steps: Step[] }>;
  };
  const sellerOnly = teamUnclaimedBranch("y", [{ suffix: "", tagSteps: [tagStep] }]) as {
    branches: Array<{ condition: unknown; steps: Step[] }>;
  };

  it("never runs on the AI-owned path (that path tags itself)", () => {
    expect(withType.when).toEqual({ var: "price_gate", notEquals: "ai" });
  });

  /**
   * The Bugbot finding on this PR: the first cut slept FIRST and filtered
   * after, parking unclaimed buyers and $1M+ owner-direct leads for two
   * hours they had no business waiting. Every filter now sits in front of
   * the sleep, so a run the rule does not cover ends instantly.
   */
  it("puts every filter BEFORE the sleep: band, lead type, and a claimed skip on the sleep itself", () => {
    // Band is the outer arm condition: $1M+ never enters.
    expect(withType.branches[0].condition).toEqual({ var: "price_band", equals: "under_1m" });
    // Lead type wraps the sleep: a buyer skips the whole block.
    const typeWrap = withType.branches[0].steps[0] as {
      branches: Array<{ condition: unknown; steps: Step[] }>;
    };
    expect(typeWrap.branches[0].condition).toEqual({ var: "route_lead_type", equals: "seller" });
    // The sleep itself skips when the lead was claimed before flow end.
    const [wait, check] = typeWrap.branches[0].steps as [
      Step,
      { branches: Array<{ condition: unknown; steps: Step[] }> }
    ];
    expect(wait).toMatchObject({
      type: "sleep",
      minutes: 120,
      when: { var: "claimed_agent", equals: "none" }
    });
    // And the post-sleep re-check is what actually admits the tag.
    expect(check.branches[0].condition).toEqual({ var: "claimed_agent", equals: "none" });
    expect(check.branches[0].steps.map((s) => s.id)).toEqual(["x_tag"]);
  });

  it("a seller-only flow drops the lead-type wrapper and stays one level shallower", () => {
    const [wait, check] = sellerOnly.branches[0].steps as [Step, Step];
    expect(wait).toMatchObject({ id: "y_tu_wait", type: "sleep" });
    expect(check).toMatchObject({ id: "y_tu_check", type: "branch" });
  });
});

describe("Clever", () => {
  it("appends the branch, tags with the auto note (a call always happened), validates", () => {
    const def = cleverFixture();
    const { changed, notes } = patchClever(def);
    expect(changed).toBe(true);
    expect(notes.join(" ")).toContain("clever_team_unclaimed");
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids[ids.length - 1]).toBe("clever_team_unclaimed");
    expect(findStepDeep(def.steps, "clever_tu_tag")).toMatchObject({
      addTags: [FOLLOW_UP_TAG],
      noteTemplate: AUTO_TAG_NOTE
    });
    expect(String(findStepDeep(def.steps, "route")!.ownerFallbackTemplate)).toContain(
      FALLBACK_TAKEOVER_LINE.trim()
    );
    validate(def);
    expect(patchClever(def).changed).toBe(false);
  });
});

describe("ReferralExchange", () => {
  it("tags seller and both (auto note), leaves buyers alone, validates", () => {
    const def = reFixture();
    expect(patchReferralExchange(def).changed).toBe(true);
    expect(findStepDeep(def.steps, "re_tu_tag_s")).toMatchObject({
      noteTemplate: AUTO_TAG_NOTE
    });
    // The lead-type conditions live on the wrapper branches, in front of the
    // sleep, so buyers never park.
    expect(
      (findStepDeep(def.steps, "re_tu_s_type") as { branches: Array<{ condition: unknown }> })
        .branches[0].condition
    ).toEqual({ var: "route_lead_type", equals: "seller" });
    expect(
      (findStepDeep(def.steps, "re_tu_b_type") as { branches: Array<{ condition: unknown }> })
        .branches[0].condition
    ).toEqual({ var: "route_lead_type", equals: "both" });
    for (const id of ["route_seller", "route_both"]) {
      expect(String(findStepDeep(def.steps, id)!.ownerFallbackTemplate)).toContain(
        FALLBACK_TAKEOVER_LINE.trim()
      );
    }
    validate(def);
    expect(patchReferralExchange(def).changed).toBe(false);
  });
});

describe("Realtor.com", () => {
  it("adds the clear-seller extraction, tags plain, leaves s4's buyer copy alone", () => {
    const def = realtorFixture();
    expect(patchRealtor(def).changed).toBe(true);
    const fields = findStepDeep(def.steps, "s1")!.fields as Array<{ name: string; description?: string }>;
    expect(fields.find((f) => f.name === "lead_type")?.description).toBe(
      REALTOR_LEAD_TYPE_FIELD.description
    );
    // Ambiguity fails safe to buyer, so only a clear seller is ever tagged.
    expect(REALTOR_LEAD_TYPE_FIELD.description).toContain("in every other case");
    const tag = findStepDeep(def.steps, "rt_tu_tag")!;
    expect((tag as { noteTemplate?: string }).noteTemplate).toBeUndefined();
    expect(
      (findStepDeep(def.steps, "rt_tu_s_type") as { branches: Array<{ condition: unknown }> })
        .branches[0].condition
    ).toEqual({ var: "lead_type", equals: "seller" });
    // s4 offers buyers too; the takeover line would be false for them.
    expect(String(findStepDeep(def.steps, "s4")!.ownerFallbackTemplate)).not.toContain(
      FALLBACK_TAKEOVER_LINE.trim()
    );
    validate(def);
    expect(patchRealtor(def).changed).toBe(false);
  });
});

describe("New Lead Intake", () => {
  it("tags seller and both plain (most were never called), validates", () => {
    const def = nliFixture();
    expect(patchNewLeadIntake(def).changed).toBe(true);
    const s = findStepDeep(def.steps, "nli_tu_tag_s")!;
    expect((s as { noteTemplate?: string }).noteTemplate).toBeUndefined();
    expect(
      (findStepDeep(def.steps, "nli_tu_s_type") as { branches: Array<{ condition: unknown }> })
        .branches[0].condition
    ).toEqual({ var: "route_variant", equals: "seller" });
    expect(
      (findStepDeep(def.steps, "nli_tu_b_type") as { branches: Array<{ condition: unknown }> })
        .branches[0].condition
    ).toEqual({ var: "route_variant", equals: "both" });
    validate(def);
    expect(patchNewLeadIntake(def).changed).toBe(false);
  });
});
