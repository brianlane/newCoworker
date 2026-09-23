import { describe, expect, it } from "vitest";
import { canvasConditionText, conditionText } from "@/lib/ai-flows/condition-text";

describe("condition text", () => {
  it("reads a blank guard as blank, not as contains an empty string", () => {
    const blank = { var: "clinic_name", blank: true as const };
    expect(conditionText(blank)).toBe("clinic_name is blank");
    expect(canvasConditionText(blank)).toBe("clinic_name is blank");
  });

  it("keeps the equals, not-equals, and contains readings", () => {
    expect(conditionText({ var: "price_band", equals: "over_1m" })).toBe('price_band equals "over_1m"');
    expect(conditionText({ var: "lead_phone", notEquals: "none" })).toBe(
      'lead_phone does not equal "none"'
    );
    expect(conditionText({ var: "lead_type", contains: "buyer" })).toBe('lead_type contains "buyer"');
    expect(canvasConditionText({ var: "lead_type", equals: "buyer" })).toBe("lead_type = \u201cbuyer\u201d");
    expect(canvasConditionText({ var: "lead_phone", notEquals: "none" })).toBe(
      "lead_phone \u2260 \u201cnone\u201d"
    );
    expect(canvasConditionText({ var: "lead_type", contains: "buyer" })).toBe(
      "lead_type contains \u201cbuyer\u201d"
    );
  });

  it("reads a condition with no operator as contains an empty value", () => {
    expect(conditionText({ var: "x" })).toBe('x contains ""');
    expect(canvasConditionText({ var: "x" })).toBe("x contains \u201c\u201d");
  });
});
