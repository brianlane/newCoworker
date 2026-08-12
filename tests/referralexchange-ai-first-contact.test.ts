import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  CALL_RESULT_BLOCK,
  FOLLOW_UP_TAG,
  LEAD_TYPES,
  PERSONAS,
  VOICEMAILS,
  buildAiFirstContactSteps,
  buildCall,
  hasAiFirstContact,
  insertAiFirstContact,
  withCallResult
} from "../scripts/oneshot/referralexchange-ai-first-contact-definition";

/**
 * ReferralExchange joins Clever and HomeLight on the AI worker: the AI calls
 * the lead first, tries a live transfer, and hands a no-answer to the
 * three-day cadence.
 */

const ref = (label: string, n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  label,
  source: "employee" as const
});
const REFS = { dave: ref("Dave Lane", 1), gabby: ref("Gabrielle Mota", 2), amy: ref("Amy Laidlaw", 3) };

/** A stand-in for the live flow: extraction, then the three route steps. */
const liveish = () => ({
  version: 1,
  trigger: { channel: "sms" as const, conditions: [{ type: "contains" as const, value: "ReferralExchange" }] },
  steps: [
    {
      id: "browse",
      type: "extract_text",
      fields: [
        { name: "lead_type" },
        { name: "lead_name" },
        { name: "lead_phone" },
        { name: "location" },
        { name: "web_source" },
        { name: "price_band" }
      ]
    },
    {
      id: "route_seller",
      type: "route_to_team",
      offerTemplate: "New seller lead {{vars.lead_name}}, reply 1 to claim",
      ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}"
    }
  ]
});

describe("the call step", () => {
  it.each(LEAD_TYPES)("gives %s its own script and voicemail", (t) => {
    const call = buildCall(t, REFS) as Record<string, unknown>;
    expect(call.personaTemplate).toBe(PERSONAS[t]);
    expect(call.voicemailTemplate).toBe(VOICEMAILS[t]);
  });

  it("gives the three lead types genuinely different scripts", () => {
    expect(new Set(Object.values(PERSONAS)).size).toBe(3);
    expect(new Set(Object.values(VOICEMAILS)).size).toBe(3);
  });

  /**
   * Amy keeps $1M+ leads herself. A POSITIVE gate, so a missing price_band
   * reads as "" and the call SKIPS: every gate on a dial path fails closed.
   */
  it("never dials a $1M+ lead, and fails closed on a missing band", () => {
    expect((buildCall("seller", REFS) as Record<string, unknown>).when).toEqual({
      var: "price_band",
      equals: "under_1m"
    });
  });

  /**
   * Matches the Clever ladder exactly, so one account does not have two ideas
   * of who gets rung first.
   */
  it("rings Dave and Gabby in turn with Amy last", () => {
    const reach = (buildCall("buyer", REFS) as { reachTeammate: Record<string, unknown> }).reachTeammate;
    expect(reach.refs).toEqual([REFS.dave, REFS.gabby, REFS.amy]);
    expect(reach.rotateFirst).toBe(2);
  });

  /**
   * The narrowed exception to Amy's never-ask-when-to-call-back rule.
   * captureFields cannot be conditional, so the SCRIPT carries the condition.
   */
  it.each(LEAD_TYPES)("%s asks about timing only after a failed transfer", (t) => {
    expect(PERSONAS[t]).toContain("ONLY THEN ask what time of day suits them");
    expect(PERSONAS[t]).toContain("Do not ask about timing at any other point");
  });

  it.each(LEAD_TYPES)("%s never quotes a price", (t) => {
    expect(PERSONAS[t]).toContain("Never quote a price");
    expect(VOICEMAILS[t]).not.toMatch(/\{\{vars\.price/);
  });
});

describe("insertion", () => {
  it("puts the AI call BEFORE the team is offered the lead", () => {
    const def = liveish();
    expect(insertAiFirstContact(def, REFS)).toBe(true);
    const ids = def.steps.map((s) => (s as { id: string }).id);
    expect(ids.indexOf("ai_first_contact")).toBeLessThan(ids.indexOf("route_seller"));
    expect(ids.indexOf("ai_no_answer_followup")).toBeLessThan(ids.indexOf("route_seller"));
  });

  /**
   * Rather than duplicating the three-day ladder, a no-answer tags the contact
   * and the cadence flow picks it up: the same chokepoint the "F" reply uses,
   * so there is one follow-up sequence and one place to change it.
   */
  it("hands a no-answer to the cadence by tagging the contact", () => {
    const steps = buildAiFirstContactSteps(REFS);
    expect(steps[1]).toMatchObject({
      type: "update_contact",
      addTags: [FOLLOW_UP_TAG],
      when: { var: "call_outcome", equals: "no_answer" }
    });
  });

  it("is idempotent", () => {
    const def = liveish();
    insertAiFirstContact(def, REFS);
    expect(hasAiFirstContact(def)).toBe(true);
    expect(insertAiFirstContact(def, REFS)).toBe(false);
  });

  // A flow that no longer has a route step is not a flow we recognize, and
  // splicing a dial ladder into it is the wrong response to that.
  it("refuses to guess when there is no route step", () => {
    const def = { steps: [{ id: "browse", type: "extract_text", fields: [{ name: "x" }] }] };
    expect(() => insertAiFirstContact(def, REFS)).toThrow(/no route_to_team step/);
  });

  it("produces a definition the authoring validator accepts", () => {
    const def = liveish();
    insertAiFirstContact(def, REFS);
    const parsed = parseAiFlowDefinition(def);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });
});

describe("what the team is told", () => {
  it("appends the call result once, and not twice", () => {
    const once = withCallResult("New lead, reply 1");
    expect(once).toContain("The AI already called them");
    expect(withCallResult(once)).toBe(once);
  });

  /**
   * captureFields are NOT flow vars: place_ai_call produces its outcome var
   * and the two companions and nothing else. The captured detail rides the
   * post-call summary to whoever the ladder rang first, so templating
   * {{vars.timeline}} here would have been rejected by the validator and would
   * have rendered empty if it had not been.
   */
  it("templates only vars the call step actually produces", () => {
    expect(CALL_RESULT_BLOCK).toContain("{{vars.call_outcome_label}}");
    expect(CALL_RESULT_BLOCK).not.toMatch(/\{\{vars\.(timeline|what_they_want|best_time)/);
  });
});
