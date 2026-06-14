import { describe, expect, it } from "vitest";
import { getAiFlowExampleCopy } from "@/lib/ai-flows/examples";

describe("getAiFlowExampleCopy", () => {
  it("keeps the original real-estate builder copy verbatim", () => {
    const copy = getAiFlowExampleCopy("real_estate");
    expect(copy.contactVar).toBe("seller_phone");
    expect(copy.tipVar).toBe("seller_phone");
    expect(copy.namePlaceholder).toBe("ReferralExchange lead follow-up");
    expect(copy.aiPromptPlaceholder).toContain("ReferralExchange");
    expect(copy.pinExample).toBe("all seller leads to one agent");
    expect(copy.whenValuePlaceholder).toBe("buyer");
    expect(copy.emailSubjectExample).toBe("{{vars.lead_name}} BS RE");
  });

  it("uses neutral copy for non-real-estate, mortgage, and unknown types", () => {
    for (const type of ["hair_salons", "mortgage_brokerage", undefined, null]) {
      const copy = getAiFlowExampleCopy(type);
      expect(copy.contactVar).toBe("contact_phone");
      expect(copy.tipVar).toBe("contact_phone");
      expect(copy.namePlaceholder).toBe("New lead follow-up");
      expect(copy.aiPromptPlaceholder).not.toContain("ReferralExchange");
      expect(copy.aiPromptPlaceholder).not.toContain("seller");
      expect(copy.pinExample).toBe("all new leads to one team member");
      expect(copy.whenValuePlaceholder).toBe("urgent");
      expect(copy.emailSubjectExample).not.toContain("BS RE");
    }
  });
});
