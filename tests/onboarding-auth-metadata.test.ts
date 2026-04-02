import { describe, expect, it } from "vitest";
import { buildSignupAuthMetadata } from "@/lib/onboarding/auth-metadata";
import type { OnboardingData } from "@/lib/onboarding/storage";

describe("buildSignupAuthMetadata", () => {
  it("returns only business name when onboarding data is absent", () => {
    expect(buildSignupAuthMetadata("Test Biz", null)).toEqual({
      business_name: "Test Biz"
    });
  });

  it("drops large assistant chat and inquiry fields from auth metadata", () => {
    const onboardingData: OnboardingData = {
      tier: "standard",
      billingPeriod: "biennial",
      businessName: "Test Biz",
      businessType: "real_estate",
      ownerName: "Brian Lane",
      ownerEmail: "chillvegandude@gmail.com",
      phone: "16026866672",
      serviceArea: "Phoenix",
      typicalInquiry: "A very long inquiry flow that should stay out of auth metadata",
      teamSize: "1",
      crmUsed: "none",
      assistantChat: {
        readyToFinalize: true,
        completionPercent: 88,
        profile: {
          businessSummary: "",
          offerings: ["Buyer representation"],
          customerTypes: ["Buyers"],
          tools: ["texts"],
          crmUsed: [],
          teamSize: "1",
          serviceArea: "Phoenix",
          toneDirectives: ["Friendly"],
          routingRules: [],
          escalationRules: [],
          policies: [],
          factsToRemember: ["Long fact"],
          schedulingRules: [],
          inquiryFlows: [],
          commonRequests: [],
          signature: "Thanks"
        },
        drafts: {
          soulMd: "# soul.md\n" + "x".repeat(4000),
          identityMd: "# identity.md\n" + "y".repeat(4000),
          memoryMd: "# memory.md\n" + "z".repeat(4000)
        }
      }
    };

    expect(buildSignupAuthMetadata("Test Biz", onboardingData)).toEqual({
      business_name: "Test Biz",
      onboarding_data: {
        tier: "standard",
        billingPeriod: "biennial",
        businessName: "Test Biz",
        businessType: "real_estate",
        ownerName: "Brian Lane",
        ownerEmail: "chillvegandude@gmail.com",
        phone: "16026866672",
        serviceArea: "Phoenix",
        teamSize: "1",
        crmUsed: "none"
      }
    });
  });
});
