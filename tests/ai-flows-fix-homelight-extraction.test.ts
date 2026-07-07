import { describe, expect, it } from "vitest";
import {
  fixHomelightExtraction,
  CARD_FIELD_DESCRIPTIONS,
  EMAIL_MATCH_TEMPLATES
} from "../scripts/oneshot/fix-homelight-extraction";

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Array<{ name?: string; description?: string }>;
  matchTemplates?: string[];
};
type Def = { steps: Step[] };

function homelightDef(): Def {
  return {
    steps: [
      {
        id: "card",
        type: "browse_extract",
        fields: [
          { name: "lead_name", description: "The lead's full name from the portal contact card" },
          { name: "lead_phone", description: "The lead's mobile phone from the contact card" },
          { name: "lead_email", description: "The lead's email from the contact card, or 'none'" },
          { name: "lead_address", description: "The property street address — with ZIP" }
        ]
      },
      {
        id: "email_card",
        type: "email_extract",
        matchTemplates: ["{{vars.lead_first_name}}", "{{vars.price_digits}}"],
        fields: [{ name: "lead_phone", description: "labeled 'Phone'" }]
      }
    ]
  };
}

describe("fixHomelightExtraction", () => {
  it("rewrites the card descriptions with 'never the agent's info' + a 'none' out", () => {
    const def = homelightDef();
    expect(fixHomelightExtraction(def, "HomeLight Referral")).toBe(true);
    const card = def.steps.find((s) => s.id === "card")!;
    for (const field of card.fields!) {
      expect(field.description).toBe(CARD_FIELD_DESCRIPTIONS[field.name!]);
      expect(field.description).toContain("answer 'none'");
    }
    expect(CARD_FIELD_DESCRIPTIONS.lead_phone).toContain("NEVER the agent's own phone");
    expect(CARD_FIELD_DESCRIPTIONS.lead_address).toContain("ZIP");
  });

  it("loosens the email match to first name only (price formats differ alert vs email)", () => {
    const def = homelightDef();
    fixHomelightExtraction(def, "HomeLight Referral");
    const email = def.steps.find((s) => s.id === "email_card")!;
    expect(email.matchTemplates).toEqual(EMAIL_MATCH_TEMPLATES);
    expect(email.matchTemplates).toEqual(["{{vars.lead_first_name}}"]);
    // email_card FIELD descriptions are untouched (they already label-match).
    expect(email.fields![0].description).toBe("labeled 'Phone'");
  });

  it("is idempotent and never touches other flows", () => {
    const def = homelightDef();
    fixHomelightExtraction(def, "HomeLight Referral");
    const once = JSON.stringify(def);
    expect(fixHomelightExtraction(def, "HomeLight Referral")).toBe(false);
    expect(JSON.stringify(def)).toBe(once);

    const other = homelightDef();
    expect(fixHomelightExtraction(other, "Clever Lead - Accept")).toBe(false);
    expect(other).toEqual(homelightDef());
  });

  it("ignores unknown card fields and steps without fields", () => {
    const def: Def = {
      steps: [
        { id: "card", type: "browse_extract", fields: [{ name: "something_else", description: "x" }] },
        { id: "card", type: "browse_extract" },
        { id: "email_card", type: "email_extract", matchTemplates: ["{{vars.lead_first_name}}"] }
      ]
    };
    expect(fixHomelightExtraction(def, "HomeLight Referral")).toBe(false);
  });
});
