import { describe, expect, it } from "vitest";
import { buildOpsNewSignupEmail } from "@/lib/email/templates/ops-new-signup";

describe("buildOpsNewSignupEmail", () => {
  it("uses owner name, email, business name, and business id in priority order", () => {
    const withName = buildOpsNewSignupEmail({
      businessId: "biz-1",
      businessName: "Scar Fairy",
      ownerName: "Scar",
      ownerEmail: "scar@example.com",
      ownerPhone: null,
      tier: "starter",
      billingPeriod: "annual",
      virtualMachineId: "123",
      didE164: null,
      siteUrl: "https://www.example.com"
    });
    expect(withName.subject).toContain("Scar Fairy");
    expect(withName.text).toContain("Scar finished onboarding");
    expect(withName.text).toContain("annual");

    const emailOnly = buildOpsNewSignupEmail({
      businessId: "biz-2",
      businessName: "",
      ownerName: null,
      ownerEmail: "owner@example.com",
      ownerPhone: "+16025551234",
      tier: "standard",
      billingPeriod: null,
      virtualMachineId: "456",
      didE164: "+16025559999",
      siteUrl: "https://www.example.com"
    });
    expect(emailOnly.text).toContain("owner@example.com");
    expect(emailOnly.text).toContain("+16025551234");

    const idFallback = buildOpsNewSignupEmail({
      businessId: "biz-3",
      businessName: "   ",
      ownerName: null,
      ownerEmail: null,
      ownerPhone: null,
      tier: "starter",
      billingPeriod: null,
      virtualMachineId: "789",
      didE164: null,
      siteUrl: "https://www.example.com"
    });
    expect(idFallback.text).toContain("biz-3 finished onboarding");
    expect(idFallback.text).toContain("(unnamed)");
    expect(idFallback.text).toContain("(not assigned yet)");
  });
});
