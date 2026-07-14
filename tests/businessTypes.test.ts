import { describe, expect, it } from "vitest";
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPE_OPTIONS,
  BUSINESS_TYPE_OTHER_VALUE,
  DEFAULT_BUSINESS_TYPE,
  deriveBusinessTypeSelection,
  isBusinessTypeSelectionComplete,
  serializeBusinessTypeSelection
} from "@/lib/onboarding/businessTypes";

describe("business type options", () => {
  it("defaults to real estate for onboarding", () => {
    expect(DEFAULT_BUSINESS_TYPE).toBe("real_estate");
    expect(BUSINESS_TYPE_LABELS[DEFAULT_BUSINESS_TYPE]).toBe("Real Estate");
  });

  it("includes the core newCoworker industries", () => {
    expect(BUSINESS_TYPE_LABELS.real_estate).toBe("Real Estate");
    expect(BUSINESS_TYPE_LABELS.dental_care).toBe("Dental Care");
    expect(BUSINESS_TYPE_LABELS.hvac_services).toBe("HVAC Services");
    expect(BUSINESS_TYPE_LABELS.medical_practice).toBe("Medical Practice");
    expect(BUSINESS_TYPE_LABELS.insurance_agency).toBe("Insurance Agency");
    expect(BUSINESS_TYPE_LABELS.mortgage_brokerage).toBe("Mortgage Brokerage");
    expect(BUSINESS_TYPE_LABELS.other).toBe("Other");
  });

  it("builds dropdown options from the labels map", () => {
    expect(BUSINESS_TYPE_OPTIONS).toHaveLength(Object.keys(BUSINESS_TYPE_LABELS).length);
    expect(BUSINESS_TYPE_OPTIONS[0]).toEqual({
      value: "real_estate",
      label: "Real Estate"
    });
    expect(BUSINESS_TYPE_OPTIONS).toContainEqual({
      value: "hvac_services",
      label: "HVAC Services"
    });
    // The dropdown label advertises the custom-text flow; the stored slug
    // and its display label (BUSINESS_TYPE_LABELS.other) stay "Other".
    expect(BUSINESS_TYPE_OPTIONS).toContainEqual({
      value: "other",
      label: "Other (I'll type it in)"
    });
  });
});

describe("custom business type selection helpers", () => {
  it("derives known slugs to themselves with no custom text", () => {
    expect(deriveBusinessTypeSelection("consulting")).toEqual({
      selection: "consulting",
      otherText: ""
    });
  });

  it("derives empty/blank storage to the unset state", () => {
    expect(deriveBusinessTypeSelection("")).toEqual({ selection: "", otherText: "" });
    expect(deriveBusinessTypeSelection("   ")).toEqual({ selection: "", otherText: "" });
    expect(deriveBusinessTypeSelection(null)).toEqual({ selection: "", otherText: "" });
    expect(deriveBusinessTypeSelection(undefined)).toEqual({ selection: "", otherText: "" });
  });

  it("derives the bare other sentinel to Other with empty text", () => {
    expect(deriveBusinessTypeSelection("other")).toEqual({
      selection: BUSINESS_TYPE_OTHER_VALUE,
      otherText: ""
    });
  });

  it("derives unknown free-text values to Other with the text preserved", () => {
    expect(deriveBusinessTypeSelection("Drone Photography")).toEqual({
      selection: BUSINESS_TYPE_OTHER_VALUE,
      otherText: "Drone Photography"
    });
  });

  it("serializes known slugs unchanged and Other to its raw custom text", () => {
    expect(serializeBusinessTypeSelection("consulting", "")).toBe("consulting");
    expect(serializeBusinessTypeSelection("", "ignored")).toBe("");
    expect(
      serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, " Drone Photography ")
    ).toBe("Drone Photography");
  });

  it("serializes Other with empty text to the bare sentinel so the form keeps its state", () => {
    expect(serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, "")).toBe(
      BUSINESS_TYPE_OTHER_VALUE
    );
    expect(serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, "   ")).toBe(
      BUSINESS_TYPE_OTHER_VALUE
    );
  });

  it("stores custom text of exactly 'other' as the display label so it doesn't collide with the sentinel", () => {
    const stored = serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, " other ");
    expect(stored).toBe("Other");
    expect(deriveBusinessTypeSelection(stored)).toEqual({
      selection: BUSINESS_TYPE_OTHER_VALUE,
      otherText: "Other"
    });
    expect(isBusinessTypeSelectionComplete(stored)).toBe(true);
  });

  it("round-trips custom text through serialize → derive", () => {
    const stored = serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, "Notary Services");
    expect(deriveBusinessTypeSelection(stored)).toEqual({
      selection: BUSINESS_TYPE_OTHER_VALUE,
      otherText: "Notary Services"
    });
  });

  it("gates advance on empty and bare-other values only", () => {
    expect(isBusinessTypeSelectionComplete("")).toBe(false);
    expect(isBusinessTypeSelectionComplete("   ")).toBe(false);
    expect(isBusinessTypeSelectionComplete(null)).toBe(false);
    expect(isBusinessTypeSelectionComplete(undefined)).toBe(false);
    expect(isBusinessTypeSelectionComplete("other")).toBe(false);
    expect(isBusinessTypeSelectionComplete("consulting")).toBe(true);
    expect(isBusinessTypeSelectionComplete("Drone Photography")).toBe(true);
  });
});
