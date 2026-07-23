import { describe, expect, it } from "vitest";
import {
  isPersonNameField,
  isSelfNameValue,
  isSelfPhone,
  scrubSelfPhones,
  withSelfNameRetryHint
} from "../supabase/functions/_shared/ai_flows/extracted_contact";

const BUSINESS_DID = "+16028053377";
const OWNER_CELL = "+16026951142";

describe("scrubSelfPhones", () => {
  it("clears extracted values that match a self number (any formatting) and reports them", () => {
    const { values, cleared } = scrubSelfPhones(
      {
        lead_name: "Amy",
        lead_phone: "(602) 805-3377", // the business DID in page formatting
        lead_email: "none",
        alt_phone: OWNER_CELL
      },
      [BUSINESS_DID, OWNER_CELL]
    );
    expect(values.lead_phone).toBe("");
    expect(values.alt_phone).toBe("");
    expect(cleared.sort()).toEqual(["alt_phone", "lead_phone"]);
    // Non-phone values are never touched — even ones as suspicious as "Amy".
    expect(values.lead_name).toBe("Amy");
    expect(values.lead_email).toBe("none");
  });

  it("keeps a legitimate lead phone VERBATIM and tolerates unparseable self numbers", () => {
    const { values, cleared } = scrubSelfPhones(
      { lead_phone: "(480) 600-8501", lead_address: "3536 E Elmwood St, Mesa, AZ 85213" },
      [BUSINESS_DID, "not-a-phone", ""]
    );
    // Surviving values are never rewritten — the scrub only clears matches.
    expect(values.lead_phone).toBe("(480) 600-8501");
    expect(values.lead_address).toBe("3536 E Elmwood St, Mesa, AZ 85213");
    expect(cleared).toEqual([]);
  });

  it("handles empty inputs", () => {
    expect(scrubSelfPhones({}, [BUSINESS_DID])).toEqual({ values: {}, cleared: [] });
    expect(scrubSelfPhones({ lead_phone: BUSINESS_DID }, [])).toEqual({
      values: { lead_phone: BUSINESS_DID },
      cleared: []
    });
  });
});

describe("isPersonNameField", () => {
  it("matches lead/seller/customer person-name fields", () => {
    // The Jul 22 2026 "Hi Amy" regression: seller_first_name extracted the
    // tenant's own agent from Clever's group intro.
    expect(isPersonNameField("seller_first_name")).toBe(true);
    expect(isPersonNameField("lead_name")).toBe(true);
    expect(isPersonNameField("customer_full_name")).toBe(true);
    expect(isPersonNameField("Name")).toBe(true);
  });

  it("excludes our-side and organization name fields", () => {
    // Hinting these with "never our agent" would push the model AWAY from
    // the correct answer.
    expect(isPersonNameField("agent_name")).toBe(false);
    expect(isPersonNameField("owner_name")).toBe(false);
    expect(isPersonNameField("team_member_name")).toBe(false);
    expect(isPersonNameField("employee_name")).toBe(false);
    expect(isPersonNameField("business_name")).toBe(false);
    expect(isPersonNameField("company_name")).toBe(false);
    expect(isPersonNameField("office_name")).toBe(false);
    expect(isPersonNameField("staff_name")).toBe(false);
  });

  it("ignores non-name fields entirely", () => {
    expect(isPersonNameField("lead_phone")).toBe(false);
    expect(isPersonNameField("price_band")).toBe(false);
    expect(isPersonNameField("lead_email")).toBe(false);
  });
});

describe("isSelfNameValue", () => {
  const SELF = ["Amy Laidlaw", "Dave Lane"];

  it("matches the full self name and its first name, case-insensitively", () => {
    expect(isSelfNameValue("Amy", SELF)).toBe(true);
    expect(isSelfNameValue("amy laidlaw", SELF)).toBe(true);
    expect(isSelfNameValue("  Amy   Laidlaw ", SELF)).toBe(true); // whitespace-collapsed
    expect(isSelfNameValue("DAVE", SELF)).toBe(true);
  });

  it("never matches a DIFFERENT person who shares a first name", () => {
    // "Amy Smith" is a real lead, not our agent — full name differs.
    expect(isSelfNameValue("Amy Smith", SELF)).toBe(false);
    expect(isSelfNameValue("Pamela", SELF)).toBe(false);
    expect(isSelfNameValue("Laidlaw", SELF)).toBe(false);
  });

  it("handles empty inputs and blank self names", () => {
    expect(isSelfNameValue("", SELF)).toBe(false);
    expect(isSelfNameValue("none", SELF)).toBe(false);
    expect(isSelfNameValue("Amy", [])).toBe(false);
    expect(isSelfNameValue("Amy", ["", "   "])).toBe(false);
  });
});

describe("withSelfNameRetryHint", () => {
  const FIELDS = [
    { name: "seller_first_name", description: "The seller's first name" },
    { name: "lead_phone", description: "The lead's phone" },
    { name: "no_desc_name" }
  ];

  it("appends the hint ONLY to suspect fields, preserving their description", () => {
    const out = withSelfNameRetryHint(FIELDS, ["seller_first_name"], ["Amy Laidlaw"]);
    expect(out[0].description).toContain("The seller's first name. ");
    expect(out[0].description).toContain("Amy Laidlaw is our own agent/business owner");
    expect(out[0].description).toContain("genuinely has the same name");
    // Non-suspect fields pass through untouched (same object shape).
    expect(out[1]).toEqual(FIELDS[1]);
    expect(out[2]).toEqual(FIELDS[2]);
  });

  it("hints a description-less suspect field and joins multiple self names", () => {
    const out = withSelfNameRetryHint(FIELDS, ["no_desc_name"], ["Amy Laidlaw", "Dave Lane"]);
    expect(out[2].description).toMatch(/^IMPORTANT: Amy Laidlaw, Dave Lane is our own/);
  });

  it("does not mutate the input field list", () => {
    withSelfNameRetryHint(FIELDS, ["seller_first_name"], ["Amy Laidlaw"]);
    expect(FIELDS[0].description).toBe("The seller's first name");
  });
});

describe("isSelfPhone", () => {
  it("normalizes BOTH sides (free-form stored self numbers still match)", () => {
    // businesses.phone is captured verbatim at onboarding — "(602) 805-3377".
    expect(isSelfPhone("+16028053377", ["(602) 805-3377"])).toBe(true);
    expect(isSelfPhone("602.805.3377", ["+16028053377"])).toBe(true);
    expect(isSelfPhone("+14806008501", ["(602) 805-3377"])).toBe(false);
  });

  it("never matches non-phone values or empty inputs", () => {
    expect(isSelfPhone("Amy", [BUSINESS_DID])).toBe(false);
    expect(isSelfPhone("", [BUSINESS_DID])).toBe(false);
    expect(isSelfPhone(BUSINESS_DID, [])).toBe(false);
  });
});
