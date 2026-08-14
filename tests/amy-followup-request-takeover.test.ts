import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import { patchFollowUpRequested } from "../scripts/oneshot/amy-followup-request-takeover";
import { FALLBACK_TAKEOVER_LINE } from "../scripts/oneshot/amy-team-unclaimed-ai-followup";
import { findStepDeep, type Definition } from "../scripts/oneshot/amy-under-500k-ai-owned";

/**
 * Fixture mirrors the LIVE "Follow Up Requested (Unclaimed Leads)" flow:
 * a reader, a buyer route (Dave/Gabby/Jason), and a seller route that takes
 * everything non-buyer (Dave/Gabby). No price_gate, no price_band, no
 * ownerDirect: the $1M+ exclusion has to come from the computed band this
 * patch adds.
 */

type Step = Record<string, unknown>;

function fixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "follow up" }] },
    steps: [
      {
        id: "read_request",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "route_lead_type" },
          { name: "price" },
          { name: "followup_note" }
        ]
      },
      {
        id: "route_buyer",
        type: "route_to_team",
        agentNames: ["Dave Lane", "Gabrielle Mota", "Jason Lane"],
        offerTemplate: "Follow-up requested: {{vars.lead_name}} ({{vars.lead_phone}})",
        ownerFallbackTemplate: "Nobody claimed the follow-up for {{vars.lead_name}}.",
        responseMinutes: 15,
        when: { var: "route_lead_type", equals: "buyer" }
      },
      {
        id: "route_seller",
        type: "route_to_team",
        agentNames: ["Dave Lane", "Gabrielle Mota"],
        offerTemplate: "Follow-up requested: {{vars.lead_name}} ({{vars.lead_phone}})",
        ownerFallbackTemplate: "Nobody claimed the follow-up for {{vars.lead_name}}.",
        responseMinutes: 15,
        when: { var: "route_lead_type", notEquals: "buyer" }
      }
    ]
  };
}

describe("Follow Up Requested takeover", () => {
  it("adds the computed band, the takeover branch, and the fallback line; validates", () => {
    const def = fixture();
    const { changed, notes } = patchFollowUpRequested(def);
    expect(changed).toBe(true);
    expect(notes.join(" ")).toContain("fur_team_unclaimed");
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids.indexOf("fur_price_lt_1m")).toBe(ids.indexOf("read_request") + 1);
    expect(ids[ids.length - 1]).toBe("fur_team_unclaimed");
    expect(String(findStepDeep(def.steps, "route_seller")!.ownerFallbackTemplate)).toContain(
      FALLBACK_TAKEOVER_LINE.trim()
    );
    // Buyers keep their route and their fallback untouched.
    expect(String(findStepDeep(def.steps, "route_buyer")!.ownerFallbackTemplate)).not.toContain(
      FALLBACK_TAKEOVER_LINE.trim()
    );
    const parsed = parseAiFlowDefinition(def);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
    expect(patchFollowUpRequested(def).changed).toBe(false);
  });

  it("has no price_gate gate (nothing produces it here) and mirrors the seller route's audience", () => {
    const def = fixture();
    patchFollowUpRequested(def);
    const branch = findStepDeep(def.steps, "fur_team_unclaimed") as {
      when?: unknown;
      branches: Array<{ condition: unknown; steps: Step[] }>;
    };
    // A when on price_gate would be rejected by the validator: nothing in
    // this flow produces the var. The branch runs for every lead and lets
    // its arms filter.
    expect(branch.when).toBeUndefined();
    expect(branch.branches[0].condition).toEqual({ var: "price_under_1m", notEquals: "no" });
    const typeWrap = branch.branches[0].steps[0] as {
      branches: Array<{ condition: unknown }>;
    };
    // Everything non-buyer, exactly the audience route_seller offers to.
    expect(typeWrap.branches[0].condition).toEqual({
      var: "route_lead_type",
      notEquals: "buyer"
    });
    // The tag is PLAIN: the lead asked for a follow-up today, and the
    // cadence's immediate round-1 call is that follow-up.
    const tag = findStepDeep(def.steps, "fur_tu_tag")!;
    expect(tag).toMatchObject({ type: "update_contact", addTags: ["Needs Follow Up"] });
    expect((tag as { noteTemplate?: string }).noteTemplate).toBeUndefined();
  });
});
