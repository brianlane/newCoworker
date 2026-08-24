/**
 * "Clever Lead - Accept" learns buyer from seller
 * (scripts/oneshot/amy-clever-lead-type.ts).
 *
 * The flow is seller-shaped by construction, because Clever Offers is a seller
 * program: every read_details field says "the seller's", the AI call pitches
 * listing against a cash offer, and the unreachable-lead broadcast was pinned
 * to the `seller` tag. Clever still sends BUYER referrals through the same
 * format (Jul 8 and Jul 31 2026), and both were handled as sellers end to end.
 *
 * The referral TEXT states it: a bare "Seller" line 116 times and a bare
 * "Buyer" line twice across this flow's 119 runs, with one silent.
 */
import { describe, expect, it } from "vitest";
import {
  CALL_GATE_STEP_ID,
  CLEVER_FLOW_NAME,
  GATED_CALL_STEP_ID,
  LEAD_TYPE_TAG_TEMPLATE,
  NO_PHONE_OFFER_STEP_ID,
  TYPE_STEP_ID,
  alreadyPatched,
  patchCleverFlow,
  readTypeStep,
  revertCleverFlow,
  walkSteps
} from "../scripts/oneshot/amy-clever-lead-type";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

type Step = Record<string, unknown> & { id: string; type: string };
type Def = { version: number; trigger: unknown; steps: Step[] };

/** Shaped like the live flow at the points this script touches. */
function fixture(): Def {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "url" },
      {
        id: "read_details",
        type: "extract_text",
        fields: [
          { name: "lead_phone", description: "The seller's mobile phone" },
          { name: "lead_address", description: "The property address" },
          { name: "price_digits", description: "The price as bare digits" }
        ]
      },
      {
        id: NO_PHONE_OFFER_STEP_ID,
        type: "route_to_team",
        broadcastAll: true,
        teamTagTemplate: "seller",
        offerTemplate: "A Clever lead arrived with NO phone number.",
        ownerFallbackTemplate: "Nobody claimed the unreachable Clever lead.",
        responseMinutes: 10
      },
      // The live flow's math step; ai_call_1's guard reads what it produces,
      // and the schema refuses a `when` on a var no EARLIER step sets. Keeping
      // it here is what proves the wrapper does not strand that guard by
      // nesting the call below the step that feeds it.
      {
        id: "clever_price_lt_1m",
        type: "math",
        operation: "less_than",
        left: "{{vars.price_digits}}",
        right: "1000000",
        saveAs: "price_under_1m"
      },
      {
        id: GATED_CALL_STEP_ID,
        type: "place_ai_call",
        toVar: "lead_phone",
        saveAs: "call_outcome",
        notifyOwner: true,
        when: { var: "price_under_1m", notEquals: "no" },
        personaTemplate: "...about selling your home on {{vars.lead_address}}..."
      },
      { id: "after_call", type: "notify_owner", message: "done" }
    ]
  };
}

describe("readTypeStep", () => {
  it("reads the TEXT, since the bare type line is a property of the SMS", () => {
    // read_details is a browse_extract against the Clever portal. The
    // "Seller" / "Buyer" line sits in the referral SMS, under the link, so
    // the type has to come from an extract_text over the trigger.
    const step = readTypeStep();
    expect(step.type).toBe("extract_text");
    const fields = step.fields as Array<{ name: string; description: string }>;
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe("lead_type");
  });

  it("offers only the two answers the source ever gives", () => {
    // No "both": Clever states one word on one line, and offering a third
    // answer it never gives invites the model to reason its way to one.
    const d = (readTypeStep().fields as Array<{ description: string }>)[0].description;
    expect(d).toContain("buyer or seller");
    expect(d).not.toContain("both");
  });

  it("defaults to seller, and says why that is a fallback and not a guess", () => {
    // Distinct from the cadence case: there the text could NEVER carry the
    // type, so the default stood in for missing information. Here it says so
    // in 118 of 119 runs, and Clever Offers is a seller program.
    const d = (readTypeStep().fields as Array<{ description: string }>)[0].description;
    expect(d).toMatch(/when the text does not state it either way, answer exactly: seller/);
  });
});

describe("patchCleverFlow", () => {
  it("puts the extraction FIRST, so every later step can read it", () => {
    const def = fixture();
    patchCleverFlow(def);
    expect(def.steps[0].id).toBe(TYPE_STEP_ID);
  });

  it("wraps the call so a buyer never gets the listing pitch", () => {
    const def = fixture();
    const { changed, problems } = patchCleverFlow(def);
    expect(problems).toEqual([]);
    expect(changed).toHaveLength(3);

    const gate = def.steps.find((s) => s.id === CALL_GATE_STEP_ID)!;
    expect(gate.type).toBe("branch");
    // The buyer arm does nothing at all; a teammate works the lead.
    const arms = gate.branches as Array<{ condition: unknown; steps: unknown[] }>;
    expect(arms).toHaveLength(1);
    expect(arms[0].condition).toEqual({ var: "lead_type", equals: "buyer" });
    expect(arms[0].steps).toEqual([]);

    // The call MOVED into the else arm: same id, same guard, not a copy.
    const inner = gate.else as Step[];
    expect(inner.map((s) => s.id)).toEqual([GATED_CALL_STEP_ID]);
    expect(inner[0].when).toEqual({ var: "price_under_1m", notEquals: "no" });
    expect(walkSteps(def.steps).filter((s) => s.id === GATED_CALL_STEP_ID)).toHaveLength(1);
    expect(def.steps.some((s) => s.id === GATED_CALL_STEP_ID)).toBe(false);
  });

  it("keeps the order of everything after the call", () => {
    // The gate replaces the call IN PLACE rather than being appended, so the
    // steps that follow still run after it.
    const def = fixture();
    patchCleverFlow(def);
    const ids = def.steps.map((s) => s.id);
    expect(ids.indexOf(CALL_GATE_STEP_ID)).toBeLessThan(ids.indexOf("after_call"));
    expect(ids.indexOf(NO_PHONE_OFFER_STEP_ID)).toBeLessThan(ids.indexOf(CALL_GATE_STEP_ID));
  });

  it("points the broadcast at the lead type instead of the literal seller", () => {
    const def = fixture();
    patchCleverFlow(def);
    const offer = walkSteps(def.steps).find((s) => s.id === NO_PHONE_OFFER_STEP_ID)!;
    expect(offer.teamTagTemplate).toBe(LEAD_TYPE_TAG_TEMPLATE);
  });

  it("produces a definition the schema accepts", () => {
    // Assert the fixture is valid FIRST. Without this, a gap in the fixture
    // (a missing required key, a template naming a var nothing produces)
    // fails this test and reads exactly like a bug in the patch.
    expect(() => parseAiFlowDefinition(fixture())).not.toThrow();
    const def = fixture();
    patchCleverFlow(def);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent", () => {
    const def = fixture();
    patchCleverFlow(def);
    expect(alreadyPatched(def)).toBe(true);
    expect(patchCleverFlow(def).changed).toEqual([]);
    // And a second pass never duplicates the call.
    expect(walkSteps(def.steps).filter((s) => s.id === GATED_CALL_STEP_ID)).toHaveLength(1);
  });

  it("round-trips through revert", () => {
    const def = fixture();
    const before = JSON.parse(JSON.stringify(def));
    patchCleverFlow(def);
    expect(revertCleverFlow(def)).toHaveLength(3);
    expect(def).toEqual(before);
    expect(revertCleverFlow(def)).toEqual([]);
  });

  it("REFUSES rather than half-patching when the live shape has moved", () => {
    // Every refusal path leaves a live flow untouched, which is the point:
    // a partially patched lead flow is worse than an unpatched one.
    const noCall = fixture();
    noCall.steps = noCall.steps.filter((s) => s.id !== GATED_CALL_STEP_ID);
    expect(patchCleverFlow(noCall).problems[0]).toContain("is missing from the flow");

    // Already nested by some earlier edit: wrapping again would duplicate it.
    const nested = fixture();
    const call = nested.steps.find((s) => s.id === GATED_CALL_STEP_ID)!;
    nested.steps = nested.steps.filter((s) => s.id !== GATED_CALL_STEP_ID);
    nested.steps.push({ id: "other", type: "branch", question: "q", branches: [], else: [call] });
    expect(patchCleverFlow(nested).problems[0]).toContain("no longer a trunk step");

    const noOffer = fixture();
    noOffer.steps = noOffer.steps.filter((s) => s.id !== NO_PHONE_OFFER_STEP_ID);
    expect(patchCleverFlow(noOffer).problems[0]).toContain(NO_PHONE_OFFER_STEP_ID);

    // A tag filter is only legal on a whole-roster broadcast; the schema
    // rejects it beside pinned recipients.
    const pinned = fixture();
    const offer = pinned.steps.find((s) => s.id === NO_PHONE_OFFER_STEP_ID)!;
    delete offer.broadcastAll;
    offer.agentNames = ["Dave Lane", "Gabrielle Mota"];
    expect(patchCleverFlow(pinned).problems[0]).toContain("broadcastAll");

    expect(patchCleverFlow({ steps: "junk" }).problems).toEqual([
      "definition has no steps array"
    ]);
  });
});

describe("walkSteps", () => {
  it("reaches nested steps and tolerates junk", () => {
    expect(walkSteps(undefined)).toEqual([]);
    expect(walkSteps([null, 7, { id: "a", type: "noop" }]).map((s) => s.id)).toEqual(["a"]);
    expect(
      walkSteps([{ id: "b", type: "branch", branches: [{ steps: [{ id: "c", type: "noop" }] }] }])
        .map((s) => s.id)
    ).toEqual(["b", "c"]);
  });
});

describe("the flow this targets", () => {
  it("names the live flow exactly", () => {
    expect(CLEVER_FLOW_NAME).toBe("Clever Lead - Accept");
  });
});
