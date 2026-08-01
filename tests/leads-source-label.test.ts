import { describe, expect, it } from "vitest";
import {
  leadSourceLabel,
  MAX_LEAD_SOURCE_LENGTH
} from "../supabase/functions/_shared/leads/source_label";

/**
 * The flow that files a lead names its source. These cases are the LIVE flow
 * names on Amy Laidlaw Real Estate, the tenant this was built for, so a
 * heuristic change that breaks her SOURCE column fails here first.
 */

describe("leadSourceLabel: live flow names", () => {
  const cases: Array<[string, string]> = [
    ["Clever Lead - Accept", "Clever"],
    ["Clever Lead - Group Reply Intro", "Clever"],
    ["Clever Lead - Group Reply Connected", "Clever"],
    ["ReferralExchange Lead", "ReferralExchange"],
    ["HomeLight Referral", "HomeLight"],
    ["Realtor.com Lead + Reply forward", "Realtor.com"],
    ["Realtor.com Lead", "Realtor.com"],
    ["HomeLight Live Transfer (AI takes the call)", "HomeLight Live Transfer"],
    ["Voice routing - calls from Clever Jake (+13056133412)", "Voice routing"]
  ];
  for (const [flowName, expected] of cases) {
    it(`${flowName} -> ${expected}`, () => {
      expect(leadSourceLabel({ flowName })).toBe(expected);
    });
  }
});

describe("leadSourceLabel: conservatism", () => {
  it("strips at most one generic trailing word", () => {
    // "New Lead Intake" must not collapse to "New": the trailing word is
    // "Intake", which is not generic.
    expect(leadSourceLabel({ flowName: "New Lead Intake" })).toBe("New Lead Intake");
  });

  it("strips only the LAST generic word, not a run of them", () => {
    expect(leadSourceLabel({ flowName: "Acme Referral Lead" })).toBe("Acme Referral");
  });

  it("never strips a single-word name down to nothing", () => {
    expect(leadSourceLabel({ flowName: "Lead" })).toBe("Lead");
    expect(leadSourceLabel({ flowName: "Referral" })).toBe("Referral");
  });

  it("leaves a name with no separator or generic word alone", () => {
    expect(leadSourceLabel({ flowName: "Clever Cue Text" })).toBe("Clever Cue Text");
    expect(leadSourceLabel({ flowName: "Zillow" })).toBe("Zillow");
  });

  it("matches the generic word case-insensitively", () => {
    expect(leadSourceLabel({ flowName: "HomeLight REFERRAL" })).toBe("HomeLight");
    expect(leadSourceLabel({ flowName: "Acme leads" })).toBe("Acme");
  });

  it("collapses interior whitespace", () => {
    expect(leadSourceLabel({ flowName: "  Acme   Homes   Lead  " })).toBe("Acme Homes");
  });

  it("cuts at the EARLIEST separator when several are present", () => {
    expect(leadSourceLabel({ flowName: "Acme (west) - Accept" })).toBe("Acme");
  });

  it("ignores a separator at position zero", () => {
    // A leading "(" is not a vendor boundary; cutting there would yield "".
    expect(leadSourceLabel({ flowName: "(internal) Acme" })).toBe("(internal) Acme");
  });
});

describe("leadSourceLabel: explicit override and edges", () => {
  it("prefers an explicit label over the flow name", () => {
    expect(leadSourceLabel({ flowName: "Clever Lead - Accept", explicit: "Clever CCC" }))
      .toBe("Clever CCC");
  });

  it("trims the explicit label and ignores a blank one", () => {
    expect(leadSourceLabel({ flowName: "HomeLight Referral", explicit: "  Zillow  " }))
      .toBe("Zillow");
    expect(leadSourceLabel({ flowName: "HomeLight Referral", explicit: "   " }))
      .toBe("HomeLight");
    expect(leadSourceLabel({ flowName: "HomeLight Referral", explicit: null }))
      .toBe("HomeLight");
  });

  it("returns null when there is nothing to work from", () => {
    expect(leadSourceLabel({ flowName: "" })).toBeNull();
    expect(leadSourceLabel({ flowName: "   " })).toBeNull();
    expect(leadSourceLabel({ flowName: undefined as unknown as string })).toBeNull();
  });

  it("clamps both paths to the lead_submissions source length", () => {
    const long = "x".repeat(MAX_LEAD_SOURCE_LENGTH + 40);
    expect(leadSourceLabel({ flowName: long })).toHaveLength(MAX_LEAD_SOURCE_LENGTH);
    expect(leadSourceLabel({ flowName: "Acme", explicit: long }))
      .toHaveLength(MAX_LEAD_SOURCE_LENGTH);
  });
});
