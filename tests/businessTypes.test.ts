import { describe, expect, it } from "vitest";
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPE_OPTIONS,
  DEFAULT_BUSINESS_TYPE
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
    expect(BUSINESS_TYPE_OPTIONS).toContainEqual({
      value: "other",
      label: "Other"
    });
  });
});
