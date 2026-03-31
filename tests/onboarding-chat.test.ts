import { describe, expect, it } from "vitest";
import {
  buildOnboardingChatSystemPrompt,
  compileIdentityMd,
  compileMemoryMd,
  compileSoulMd,
  compileRowboatMarkdownDrafts,
  createEmptyAssistantProfile,
  onboardingInquiryFlowSchema,
  onboardingAssistantProfileSchema
} from "@/lib/onboarding/chat";

describe("onboarding chat helpers", () => {
  it("builds a system prompt that is industry agnostic and md-aware", () => {
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind Services",
      businessType: "hvac_services"
    });

    expect(prompt).toContain("industry agnostic");
    expect(prompt).toContain("SOUL.md");
    expect(prompt).toContain("IDENTITY.md");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("Ask one focused question at a time");
  });

  it("embeds an existing profile in the system prompt when provided", () => {
    const prompt = buildOnboardingChatSystemPrompt(
      { businessName: "Northwind Services" },
      {
        ...createEmptyAssistantProfile(),
        businessSummary: "Known summary"
      }
    );

    expect(prompt).toContain("Known summary");
  });

  it("creates an empty assistant profile with blank arrays and strings", () => {
    const profile = createEmptyAssistantProfile();

    expect(profile.businessSummary).toBe("");
    expect(profile.offerings).toEqual([]);
    expect(profile.inquiryFlows).toEqual([]);
    expect(profile.signature).toBe("");
  });

  it("compiles rowboat markdown drafts from known context and profile", () => {
    const drafts = compileRowboatMarkdownDrafts(
      {
        businessName: "Northwind Services",
        businessType: "hvac_services",
        ownerName: "Jamie Smith",
        serviceArea: "Phoenix, AZ",
        teamSize: "4",
        phone: "555-111-2222"
      },
      {
        businessSummary: "A residential HVAC company focused on fast response and maintenance plans.",
        offerings: ["Emergency HVAC repair", "Seasonal maintenance"],
        customerTypes: ["Homeowners", "Landlords"],
        commonRequests: ["Availability", "Pricing questions"],
        inquiryFlows: [
          {
            trigger: "A customer says the AC stopped working.",
            responseGoal: "Collect urgency, ask for address, and move toward scheduling."
          }
        ],
        routingRules: ["Route maintenance-plan billing questions to office staff."],
        schedulingRules: ["Offer the next available service window."],
        escalationRules: ["Escalate safety issues to a human immediately."],
        tools: ["Gmail", "Google Calendar"],
        toneDirectives: ["Be calm, clear, and reassuring."],
        signature: "Thanks, Northwind Services",
        policies: ["Do not promise technician arrival times that are not confirmed."],
        factsToRemember: ["Offers 24/7 emergency service."]
      }
    );

    expect(drafts.identityMd).toContain("Business Name: Northwind Services");
    expect(drafts.identityMd).toContain("Industry: Hvac Services");
    expect(drafts.soulMd).toContain("Be calm, clear, and reassuring.");
    expect(drafts.soulMd).toContain("Thanks, Northwind Services");
    expect(drafts.memoryMd).toContain("## Business Summary");
    expect(drafts.memoryMd).toContain("## Customer Types");
    expect(drafts.memoryMd).toContain("Offers 24/7 emergency service.");
    expect(drafts.memoryMd).toContain("Cause: A customer says the AC stopped working.");
  });

  it("uses fallback copy when context and profile details are sparse", () => {
    const profile = createEmptyAssistantProfile();

    const identityMd = compileIdentityMd({}, profile);
    const soulMd = compileSoulMd(profile);
    const memoryMd = compileMemoryMd({}, profile);

    expect(identityMd).toContain("Business Name: Unknown Business");
    expect(identityMd).toContain("Business context still being collected.");
    expect(identityMd).toContain("Offerings not captured yet.");
    expect(soulMd).toContain("Use a professional, helpful, and concise tone.");
    expect(soulMd).toContain("Use the business's preferred sign-off when one is provided.");
    expect(memoryMd).toContain("Business: Unknown Business");
    expect(memoryMd).toContain("Business summary not captured yet.");
    expect(memoryMd).toContain("No customer types captured yet.");
    expect(memoryMd).toContain("No concrete inquiry flows captured yet.");
    expect(memoryMd).toContain("No tools captured yet.");
  });

  it("normalizes loose model profile output into the expected shape", () => {
    const parsed = onboardingAssistantProfileSchema.parse({
      businessSummary: "Fast-growing service business",
      offerings: "Consulting",
      customerTypes: ["SMBs"],
      commonRequests: "Pricing",
      inquiryFlows: [{ trigger: "Lead asks for pricing", responseGoal: "Qualify and offer next step" }],
      routingRules: "Send enterprise leads to owner",
      schedulingRules: [],
      escalationRules: "Escalate complaints immediately",
      tools: "Gmail",
      toneDirectives: "Warm and concise",
      signature: "Thanks, Team",
      policies: "Do not promise refunds without approval",
      factsToRemember: "Primary market is Phoenix"
    });

    expect(parsed.offerings).toEqual(["Consulting"]);
    expect(parsed.commonRequests).toEqual(["Pricing"]);
    expect(parsed.routingRules).toEqual(["Send enterprise leads to owner"]);
    expect(parsed.tools).toEqual(["Gmail"]);
    expect(parsed.toneDirectives).toEqual(["Warm and concise"]);
    expect(parsed.policies).toEqual(["Do not promise refunds without approval"]);
    expect(parsed.factsToRemember).toEqual(["Primary market is Phoenix"]);
  });

  it("drops invalid normalization inputs to safe empty defaults", () => {
    const parsed = onboardingAssistantProfileSchema.parse({
      businessSummary: 42,
      offerings: "",
      customerTypes: null,
      commonRequests: ["Pricing", 123, null],
      inquiryFlows: [null, "bad", {}, { trigger: "Only trigger" }, { responseGoal: "Only effect" }],
      routingRules: undefined,
      schedulingRules: "",
      escalationRules: null,
      tools: ["HubSpot", false],
      toneDirectives: "",
      signature: null,
      policies: undefined,
      factsToRemember: null
    });

    expect(parsed.businessSummary).toBe("");
    expect(parsed.offerings).toEqual([]);
    expect(parsed.customerTypes).toEqual([]);
    expect(parsed.commonRequests).toEqual(["Pricing"]);
    expect(parsed.inquiryFlows).toEqual([
      { trigger: "Only trigger", responseGoal: "" },
      { trigger: "", responseGoal: "Only effect" }
    ]);
    expect(parsed.routingRules).toEqual([]);
    expect(parsed.schedulingRules).toEqual([]);
    expect(parsed.escalationRules).toEqual([]);
    expect(parsed.tools).toEqual(["HubSpot"]);
    expect(parsed.toneDirectives).toEqual([]);
    expect(parsed.signature).toBe("");
    expect(parsed.policies).toEqual([]);
    expect(parsed.factsToRemember).toEqual([]);
  });

  it("normalizes inquiry flow inputs at the schema level", () => {
    expect(onboardingInquiryFlowSchema.parse(null)).toEqual({
      trigger: "",
      responseGoal: ""
    });

    expect(onboardingInquiryFlowSchema.parse({ trigger: "Lead asks a question" })).toEqual({
      trigger: "Lead asks a question",
      responseGoal: ""
    });

    expect(onboardingInquiryFlowSchema.parse({ responseGoal: "Route to a human" })).toEqual({
      trigger: "",
      responseGoal: "Route to a human"
    });
  });

  it("normalizes non-array inquiryFlows to an empty list", () => {
    const parsed = onboardingAssistantProfileSchema.parse({
      ...createEmptyAssistantProfile(),
      inquiryFlows: "not-an-array"
    });

    expect(parsed.inquiryFlows).toEqual([]);
  });
});
