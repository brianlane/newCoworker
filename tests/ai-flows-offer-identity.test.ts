import { describe, expect, it } from "vitest";
import {
  ambiguousClaimText,
  bareDigitAmbiguityText,
  claimAckText,
  joinLabels,
  leadLabelFromVars,
  leadPhoneFromVars,
  leadShortLabel,
  matchOfferByLeadName,
  normalizeLeadName,
  type OfferCandidate
} from "../supabase/functions/_shared/ai_flows/offer_identity";

/**
 * Naming which lead a "1, <name>" reply means. The rule that matters most:
 * a suffix that matches no lead must fall through untouched so the existing
 * ETA reply ("1, 20 min") keeps working exactly as it did.
 */

const DANIEL: OfferCandidate = {
  runId: "run-daniel",
  leadLabel: "Daniel Villanueva",
  leadPhone: "+14802949456"
};
const DAN: OfferCandidate = { runId: "run-dan", leadLabel: "Dan Reyes", leadPhone: "+16025550100" };
const MUNOZ: OfferCandidate = { runId: "run-munoz", leadLabel: "Sofía Muñoz" };

describe("leadLabelFromVars / leadPhoneFromVars", () => {
  it("prefers lead_name and lead_phone", () => {
    const vars = { lead_name: "Daniel Villanueva", name: "ignored", lead_phone: "+14802949456" };
    expect(leadLabelFromVars(vars)).toBe("Daniel Villanueva");
    expect(leadPhoneFromVars(vars)).toBe("+14802949456");
  });

  it("falls back through the alternates when the primary is absent", () => {
    expect(leadLabelFromVars({ customer_name: "Pat Lee" })).toBe("Pat Lee");
    expect(leadPhoneFromVars({ contact_phone: "+15551230000" })).toBe("+15551230000");
  });

  it("treats extraction placeholders as absent, not as a lead named 'none'", () => {
    // New Lead Intake writes the literal "not given" when Amy omits a field.
    expect(leadLabelFromVars({ lead_name: "none", customer_name: "Real Person" })).toBe("Real Person");
    expect(leadLabelFromVars({ lead_name: "not given" })).toBe("");
    expect(leadLabelFromVars({ lead_name: "   " })).toBe("");
  });

  it("returns empty for missing vars and non-string values", () => {
    expect(leadLabelFromVars(undefined)).toBe("");
    expect(leadLabelFromVars({})).toBe("");
    expect(leadLabelFromVars({ lead_name: 42 })).toBe("");
  });
});

describe("leadShortLabel", () => {
  it("takes the first name, which is what a teammate would type", () => {
    expect(leadShortLabel("Daniel Villanueva")).toBe("Daniel");
    expect(leadShortLabel("  Cher  ")).toBe("Cher");
    expect(leadShortLabel("")).toBe("");
  });
});

describe("normalizeLeadName", () => {
  it("folds case, accents, and punctuation", () => {
    expect(normalizeLeadName("Sofía Muñoz")).toBe("sofia munoz");
    expect(normalizeLeadName("O'Brien-Smith")).toBe("o brien smith");
    expect(normalizeLeadName("  Daniel   Villanueva ")).toBe("daniel villanueva");
  });
});

describe("matchOfferByLeadName", () => {
  it("matches a first name", () => {
    expect(matchOfferByLeadName([DANIEL, MUNOZ], "Daniel")).toEqual({
      kind: "one",
      runId: "run-daniel",
      label: "Daniel Villanueva"
    });
  });

  it("matches a surname and a partial surname", () => {
    expect(matchOfferByLeadName([DANIEL, DAN], "villanueva")).toMatchObject({ runId: "run-daniel" });
    expect(matchOfferByLeadName([DANIEL, DAN], "reyes")).toMatchObject({ runId: "run-dan" });
  });

  it("matches across the accent a teammate will not type", () => {
    expect(matchOfferByLeadName([DANIEL, MUNOZ], "munoz")).toMatchObject({ runId: "run-munoz" });
    expect(matchOfferByLeadName([DANIEL, MUNOZ], "sofia")).toMatchObject({ runId: "run-munoz" });
  });

  it("reports ambiguity instead of guessing when a prefix fits two leads", () => {
    const result = matchOfferByLeadName([DANIEL, DAN], "dan");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.labels).toEqual(["Daniel Villanueva", "Dan Reyes"]);
  });

  it("lets an exact full match win over a longer partial", () => {
    // "Dan" is a real lead here; typing it must take Dan, not stall on Daniel.
    const exactDan: OfferCandidate = { runId: "run-exact", leadLabel: "Dan" };
    expect(matchOfferByLeadName([DANIEL, exactDan], "dan")).toMatchObject({ runId: "run-exact" });
  });

  it("disambiguates two identically-named leads by phone tail", () => {
    const twinA: OfferCandidate = { runId: "a", leadLabel: "Chris Bell", leadPhone: "+14805551234" };
    const twinB: OfferCandidate = { runId: "b", leadLabel: "Chris Bell", leadPhone: "+14805559876" };
    const result = matchOfferByLeadName([twinA, twinB], "Chris Bell");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.labels).toEqual(["Chris Bell (...1234)", "Chris Bell (...9876)"]);
  });

  it("falls back to the bare name when duplicates have no usable phone", () => {
    const twinA: OfferCandidate = { runId: "a", leadLabel: "Chris Bell" };
    const twinB: OfferCandidate = { runId: "b", leadLabel: "Chris Bell", leadPhone: "12" };
    const result = matchOfferByLeadName([twinA, twinB], "Chris Bell");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    // Nothing useful to append, so we say the name twice rather than inventing
    // a distinguisher the teammate cannot act on.
    expect(result.labels).toEqual(["Chris Bell", "Chris Bell"]);
  });

  it("returns none for an ETA, so 1, 20 min keeps its existing meaning", () => {
    expect(matchOfferByLeadName([DANIEL, DAN], "20 min")).toEqual({ kind: "none" });
    expect(matchOfferByLeadName([DANIEL], "1 hr 30 min")).toEqual({ kind: "none" });
    expect(matchOfferByLeadName([DANIEL], "45")).toEqual({ kind: "none" });
  });

  it("returns none for empty input and for candidates with no captured name", () => {
    expect(matchOfferByLeadName([DANIEL], "")).toEqual({ kind: "none" });
    expect(matchOfferByLeadName([DANIEL], "   ")).toEqual({ kind: "none" });
    expect(matchOfferByLeadName([{ runId: "x", leadLabel: "" }], "daniel")).toEqual({ kind: "none" });
    expect(matchOfferByLeadName([], "daniel")).toEqual({ kind: "none" });
  });
});

describe("reply copy", () => {
  it("joins labels readably", () => {
    expect(joinLabels([])).toBe("");
    expect(joinLabels(["A"])).toBe("A");
    expect(joinLabels(["A", "B"])).toBe("A or B");
    expect(joinLabels(["A", "B", "C"])).toBe("A, B or C");
  });

  it("asks which lead rather than claiming one", () => {
    const text = ambiguousClaimText(["Daniel Villanueva", "Dan Reyes"]);
    expect(text).toContain("Which one?");
    expect(text).toContain("Daniel Villanueva or Dan Reyes");
  });

  it("lists the pending leads when a bare digit arrives", () => {
    const text = bareDigitAmbiguityText(["Daniel Villanueva", "Dan Reyes"]);
    expect(text).toContain("You have 2 unclaimed leads");
    expect(text).toContain('Reply "1, <name>"');
  });

  it("confirms the claim by name", () => {
    expect(claimAckText("Daniel Villanueva")).toBe("Got it, Daniel Villanueva is yours.");
  });

  it("keeps every reply free of em dashes", () => {
    for (const text of [
      ambiguousClaimText(["A", "B"]),
      bareDigitAmbiguityText(["A", "B"]),
      claimAckText("A")
    ]) {
      expect(text).not.toMatch(/—/);
    }
  });
});
