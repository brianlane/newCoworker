import { describe, expect, it } from "vitest";
import { buildComplianceSystemPrompt, hasFhaRisk } from "@/lib/compliance/fha";

describe("fha compliance", () => {
  it("detects risky protected-class terms", () => {
    expect(hasFhaRisk("We should target by race")).toBe(true);
  });

  it("allows neutral language", () => {
    expect(hasFhaRisk("Please schedule a showing tomorrow")).toBe(false);
  });

  it("builds a non-empty guardrail prompt", () => {
    expect(buildComplianceSystemPrompt()).toContain("Fair Housing Act");
  });
});
