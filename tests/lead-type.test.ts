import { describe, expect, it } from "vitest";
import {
  decideInferredLeadType,
  leadTypeFromRunContext,
  leadTypeFromText,
  normalizeLeadType
} from "../supabase/functions/_shared/lead_type";

describe("normalizeLeadType", () => {
  it("accepts buyer, seller, and both in any casing", () => {
    expect(normalizeLeadType("seller")).toBe("seller");
    expect(normalizeLeadType("Buyer")).toBe("buyer");
    expect(normalizeLeadType("  BOTH  ")).toBe("both");
  });

  it("rejects reachability-gate none, typos, and empty values", () => {
    for (const raw of [null, undefined, "", "   ", "none", "sellr", 12]) {
      expect(normalizeLeadType(raw)).toBeNull();
    }
  });
});

describe("leadTypeFromText", () => {
  it("reads the cadence note line", () => {
    expect(leadTypeFromText("auto_first_contact; lead_type: seller")).toBe("seller");
    expect(leadTypeFromText("lead_type: BUYER")).toBe("buyer");
    expect(leadTypeFromText("Lead type: both")).toBeNull();
  });

  it("returns null when the note has no type", () => {
    expect(leadTypeFromText(null)).toBeNull();
    expect(leadTypeFromText("")).toBeNull();
    expect(leadTypeFromText("auto_first_contact")).toBeNull();
  });
});

describe("leadTypeFromRunContext", () => {
  it("prefers vars.lead_type", () => {
    expect(
      leadTypeFromRunContext({
        vars: { lead_type: "seller", route_lead_type: "buyer" }
      })
    ).toBe("seller");
  });

  it("ignores a vars blob that is not a plain object", () => {
    expect(leadTypeFromRunContext({ vars: "lead_type: seller" })).toBe("seller");
    expect(leadTypeFromRunContext({ vars: 12 })).toBeNull();
  });

  it("uses route_lead_type only when it is a real type, never none", () => {
    expect(leadTypeFromRunContext({ vars: { route_lead_type: "buyer" } })).toBe("buyer");
    expect(leadTypeFromRunContext({ vars: { route_lead_type: "none" } })).toBeNull();
  });

  it("falls back to a lead_type line in the context blob", () => {
    expect(
      leadTypeFromRunContext({
        trigger: { windowText: "Needs Follow Up; lead_type: both" }
      })
    ).toBe("both");
  });

  it("returns null for missing or empty context", () => {
    expect(leadTypeFromRunContext(null)).toBeNull();
    expect(leadTypeFromRunContext({})).toBeNull();
  });
});

describe("decideInferredLeadType", () => {
  it("returns the type when every source agrees", () => {
    expect(decideInferredLeadType(["seller", "seller", null])).toBe("seller");
  });

  it("returns null when nothing is stored or sources disagree", () => {
    expect(decideInferredLeadType([])).toBeNull();
    expect(decideInferredLeadType([null, null])).toBeNull();
    expect(decideInferredLeadType(["seller", "buyer"])).toBeNull();
  });
});
