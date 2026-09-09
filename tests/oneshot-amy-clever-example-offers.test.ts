/**
 * Stop quoting Clever's Example only cash-offer placeholders
 * (scripts/oneshot/amy-clever-example-offers.ts).
 *
 * The spoken pitch interpolated `{{vars.cash_offers}}`, and the page read
 * that fills that var copied Clever's sample ZoomCasa/QuickBuy pair. These
 * tests pin the two in-place string edits against a fixture shaped like
 * the live flows, then prove a second pass is a no-op.
 */
import { describe, expect, it } from "vitest";
import {
  CASH_OFFERS_FIELD,
  NEVER_QUOTE_CASH_OFFERS,
  OLD_CASH_OFFERS_FIELD_DESCRIPTION,
  OLD_CLEVER_OFFERS_CLAUSE,
  PITCH_CLEVER
} from "../scripts/oneshot/amy-seller-ai-call-definition";
import {
  CLEVER_ACCEPT_FLOW_NAME,
  SPOKE_CHECK_FLOW_NAME,
  TARGET_FLOW_NAMES,
  patchCleverExampleOffers,
  walkSteps,
  type AnyDef
} from "../scripts/oneshot/amy-clever-example-offers";

function acceptFixture(): AnyDef {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever" }] },
    steps: [
      {
        id: "read_details",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [
          { name: "lead_name", description: "name" },
          { name: "cash_offers", description: OLD_CASH_OFFERS_FIELD_DESCRIPTION }
        ]
      },
      {
        id: "clever_call_gate",
        type: "branch",
        question: "buyer?",
        branches: [
          {
            id: "buyer",
            label: "buyer",
            condition: { var: "lead_type", equals: "buyer" },
            steps: []
          }
        ],
        else: [
          {
            id: "ai_call_1",
            type: "place_ai_call",
            toVar: "lead_phone",
            personaTemplate:
              "0. " +
              OLD_CLEVER_OFFERS_CLAUSE +
              " Acknowledge it, then make the case plainly: listing the home almost always nets more than a quick cash sale, and we will show you the numbers rather than ask you to take our word for it.",
            saveAs: "call_outcome"
          }
        ]
      }
    ]
  };
}

function spokeFixture(): AnyDef {
  return {
    version: 1,
    trigger: { channel: "owner_assigned", conditions: [] },
    steps: [
      {
        id: "read_page",
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [
          { name: "lead_address", description: "address" },
          { name: "cash_offers", description: OLD_CASH_OFFERS_FIELD_DESCRIPTION }
        ]
      },
      {
        id: "week_1_call",
        type: "place_ai_call",
        toVar: "lead_phone",
        personaTemplate: "We're following up to discuss the cash offers on your home through Clever.",
        saveAs: "call_outcome"
      }
    ]
  };
}

describe("patchCleverExampleOffers", () => {
  it("names the two live flows this script is allowed to touch", () => {
    expect(TARGET_FLOW_NAMES).toEqual([CLEVER_ACCEPT_FLOW_NAME, SPOKE_CHECK_FLOW_NAME]);
  });

  it("drops the interpolated amounts from nested seller-call personas and hardens the field", () => {
    const def = acceptFixture();
    const notes = patchCleverExampleOffers(def);
    expect(notes.length).toBe(2);
    const call = walkSteps(def.steps).find((s) => s.id === "ai_call_1")!;
    expect(String(call.personaTemplate)).not.toContain("{{vars.cash_offers}}");
    expect(String(call.personaTemplate)).toContain(NEVER_QUOTE_CASH_OFFERS);
    const field = (
      (def.steps![0] as { fields: Array<{ name: string; description: string }> }).fields
    ).find((f) => f.name === "cash_offers");
    expect(field?.description).toBe(CASH_OFFERS_FIELD.description);
    expect(patchCleverExampleOffers(def)).toEqual([]);
  });

  it("hardens the spoke-check extractor and leaves its persona (which quotes no figures) alone", () => {
    const def = spokeFixture();
    const notes = patchCleverExampleOffers(def);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("read_page");
    const call = walkSteps(def.steps).find((s) => s.id === "week_1_call")!;
    expect(call.personaTemplate).toBe(
      "We're following up to discuss the cash offers on your home through Clever."
    );
    expect(patchCleverExampleOffers(def)).toEqual([]);
  });

  it("walks an empty tree without throwing", () => {
    expect(walkSteps(undefined)).toEqual([]);
    expect(patchCleverExampleOffers({})).toEqual([]);
  });

  it("the builder pitch is already the post-patch wording", () => {
    expect(PITCH_CLEVER).not.toContain("{{vars.cash_offers}}");
    expect(PITCH_CLEVER).toContain(NEVER_QUOTE_CASH_OFFERS);
  });
});
