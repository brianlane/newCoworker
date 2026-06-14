import { describe, expect, it } from "vitest";
import { buildComplianceSystemPrompt, hasFhaRisk, isFhaBusinessType } from "@/lib/compliance/fha";

describe("fha compliance", () => {
  it("detects risky protected-class terms", () => {
    expect(hasFhaRisk("We should target by race")).toBe(true);
    expect(hasFhaRisk("Discriminate based on color")).toBe(true);
    expect(hasFhaRisk("No one of that sex allowed")).toBe(true);
  });

  it("allows neutral language", () => {
    expect(hasFhaRisk("Please schedule a showing tomorrow")).toBe(false);
  });

  it("flags only housing business types as FHA-covered", () => {
    expect(isFhaBusinessType("real_estate")).toBe(true);
    expect(isFhaBusinessType("mortgage_brokerage")).toBe(true);
    expect(isFhaBusinessType("hvac_services")).toBe(false);
    expect(isFhaBusinessType(null)).toBe(false);
    expect(isFhaBusinessType(undefined)).toBe(false);
  });

  it("uses Fair Housing Act guardrails for housing business types", () => {
    expect(buildComplianceSystemPrompt("real_estate")).toContain("Fair Housing Act");
    expect(buildComplianceSystemPrompt("mortgage_brokerage")).toContain("Fair Housing Act");
  });

  it("uses a neutral guardrail for non-housing and unknown business types", () => {
    const generic = buildComplianceSystemPrompt("hvac_services");
    expect(generic).not.toContain("Fair Housing Act");
    expect(generic).toContain("legal and ethical guardrails");

    const unknown = buildComplianceSystemPrompt();
    expect(unknown).not.toContain("Fair Housing Act");
    expect(unknown).toContain("legal and ethical guardrails");
  });
});
