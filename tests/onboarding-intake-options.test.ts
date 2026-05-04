import { describe, expect, it } from "vitest";
import {
  CRM_OPTIONS,
  CRM_OTHER_PREFIX,
  CRM_OTHER_VALUE,
  TEAM_SIZE_OPTIONS,
  deriveCrmSelection,
  serializeCrmSelection
} from "@/lib/onboarding/intakeOptions";

describe("intakeOptions: TEAM_SIZE_OPTIONS", () => {
  it("exposes a closed-class team-size enum that downstream identity.md can render verbatim", () => {
    // Identity.md uses `knownContext.teamSize` directly as a string;
    // the values must be human-readable, stable, and mutually
    // exclusive. Pin the full enum to make any future drift
    // explicit.
    expect(TEAM_SIZE_OPTIONS.map((option) => option.value)).toEqual([
      "Just me",
      "2-3",
      "4-5",
      "6-10",
      "11-25",
      "25+"
    ]);
  });

  it("uses en-dash labels even though the values use ASCII hyphens (label vs value separation)", () => {
    // Labels contain en-dashes ("2–3") for visual polish, but the
    // values use ASCII hyphens ("2-3") so that `identity.md` and any
    // downstream string comparisons stay ASCII-safe. Asserting the
    // distinction prevents accidental unification that would break
    // either rendering or persisted data round-tripping.
    const range = TEAM_SIZE_OPTIONS.find((option) => option.value === "2-3");
    expect(range).toBeDefined();
    expect(range?.label).toBe("2–3");
  });
});

describe("intakeOptions: CRM_OPTIONS", () => {
  it("starts with the explicit None-CRM entry so single-operator users have a positive answer", () => {
    // Pre-migration the chat had to scan transcripts for "I just use
    // texts/email" and treat that as a CRM-known signal. Now the
    // dropdown carries an explicit value the user can pick — there
    // is no ambiguity between "user skipped" and "user said no
    // CRM".
    expect(CRM_OPTIONS[0]?.value).toBe("None — texts, email, or calendar only");
    expect(CRM_OPTIONS[0]?.label).toBe("None — texts, email, or calendar only");
  });

  it("ends with an Other escape hatch so the dropdown isn't an exhaustive enumeration", () => {
    expect(CRM_OPTIONS[CRM_OPTIONS.length - 1]?.value).toBe(CRM_OTHER_VALUE);
  });
});

describe("intakeOptions: deriveCrmSelection / serializeCrmSelection round-trip", () => {
  it("treats unset CRM as { selection: '', otherText: '' }", () => {
    expect(deriveCrmSelection("")).toEqual({ selection: "", otherText: "" });
    expect(deriveCrmSelection(undefined)).toEqual({ selection: "", otherText: "" });
    expect(deriveCrmSelection(null)).toEqual({ selection: "", otherText: "" });
  });

  it("maps a known label directly to its dropdown selection (case-insensitive)", () => {
    expect(deriveCrmSelection("HubSpot")).toEqual({ selection: "HubSpot", otherText: "" });
    expect(deriveCrmSelection("hubspot")).toEqual({ selection: "HubSpot", otherText: "" });
    expect(deriveCrmSelection("Follow Up Boss")).toEqual({
      selection: "Follow Up Boss",
      otherText: ""
    });
  });

  it("decomposes the Other-prefix into selection + free-text", () => {
    expect(deriveCrmSelection("Other: Wise Agent")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "Wise Agent"
    });
  });

  it("buckets unknown free-text values as Other so legacy localStorage drafts don't lose their answer", () => {
    // Pre-migration users had a free-text CRM field. When their
    // draft rehydrates against the new dropdown, the value should
    // surface in the Other-text field rather than disappear or
    // silently match an unintended option.
    expect(deriveCrmSelection("My Custom Vertical CRM")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "My Custom Vertical CRM"
    });
  });

  it("trims surrounding whitespace on both halves of the Other prefix", () => {
    expect(deriveCrmSelection("  Other:   Wise Agent   ")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "Wise Agent"
    });
  });

  it("serializes a known selection back to its label verbatim", () => {
    expect(serializeCrmSelection("HubSpot", "")).toBe("HubSpot");
    expect(serializeCrmSelection("None — texts, email, or calendar only", "")).toBe(
      "None — texts, email, or calendar only"
    );
  });

  it("serializes Other + non-empty text with the canonical prefix", () => {
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "Wise Agent")).toBe(
      `${CRM_OTHER_PREFIX}Wise Agent`
    );
  });

  it("serializes Other with empty text as '' so step-advance validation can flag it", () => {
    // The dropdown can be in an "Other" state without the user
    // having typed anything yet. We model that as an unfilled field
    // (empty stored value) rather than as `Other: ` so the existing
    // `!form.crmUsed.trim()` advance gate works without a special
    // case.
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "")).toBe("");
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "   ")).toBe("");
  });

  it("serializes empty selection as ''", () => {
    expect(serializeCrmSelection("", "")).toBe("");
    expect(serializeCrmSelection("", "stray text")).toBe("");
  });

  it("round-trips every supported (selection, text) pair without lossy mutation", () => {
    const cases: { selection: string; otherText: string; expectedStored: string }[] = [
      ...CRM_OPTIONS.filter((option) => option.value !== CRM_OTHER_VALUE).map((option) => ({
        selection: option.value,
        otherText: "",
        expectedStored: option.value
      })),
      { selection: CRM_OTHER_VALUE, otherText: "Wise Agent", expectedStored: "Other: Wise Agent" }
    ];
    for (const { selection, otherText, expectedStored } of cases) {
      const stored = serializeCrmSelection(selection, otherText);
      expect(stored).toBe(expectedStored);
      expect(deriveCrmSelection(stored)).toEqual({ selection, otherText });
    }
  });
});
