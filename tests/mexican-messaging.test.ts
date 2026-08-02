import { describe, expect, it } from "vitest";
import {
  MEXICO_MESSAGING_FEE_MONTHLY_CENTS,
  MEXICO_MESSAGING_FEE_NAME,
  isMexicanBusiness
} from "@/lib/plans/mexican-messaging";
import { resolveBusinessCountry } from "@/lib/plans/business-country";

describe("mexican messaging surcharge constants", () => {
  it("pins the fee amount and the Stripe line-item sentinel name", () => {
    expect(MEXICO_MESSAGING_FEE_MONTHLY_CENTS).toBe(999);
    expect(MEXICO_MESSAGING_FEE_NAME).toBe("Mexican messaging surcharge");
  });
});

describe("isMexicanBusiness", () => {
  it("delegates to resolveBusinessCountry (phone authoritative, timezone fallback)", () => {
    const cases = [
      { phone: "+525512345678" },
      { phone: "52 55 1234 5678", timezone: "America/Toronto" },
      { phone: "+447911123456", timezone: "America/Mexico_City" },
      { phone: "(416) 456-0696", timezone: "America/Mexico_City" },
      { phone: null, timezone: "America/Phoenix" },
      {}
    ];
    for (const input of cases) {
      expect(isMexicanBusiness(input)).toBe(resolveBusinessCountry(input) === "MX");
    }
  });

  it("classifies the canonical shapes", () => {
    expect(isMexicanBusiness({ phone: "+52 55 1234 5678" })).toBe(true);
    expect(isMexicanBusiness({ phone: null, timezone: "America/Monterrey" })).toBe(true);
    expect(isMexicanBusiness({ phone: "(602) 555-0100", timezone: "America/Monterrey" })).toBe(
      false
    );
    expect(isMexicanBusiness({})).toBe(false);
  });
});
