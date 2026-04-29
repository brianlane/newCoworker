import { describe, expect, it } from "vitest";
import {
  buildOnboardingChatSystemPrompt,
  compileIdentityMd,
  compileMemoryMd,
  compileSoulMd,
  compileRowboatMarkdownDrafts,
  createEmptyAssistantProfile,
  finalizeAssistantMessage,
  MAX_ONBOARDING_CHAT_MESSAGES,
  onboardingChatMessageSchema,
  onboardingChatModelResponseSchema,
  onboardingInquiryFlowSchema,
  ONBOARDING_CHAT_RATE_LIMIT,
  onboardingAssistantProfileSchema,
  summarizeOnboardingTopicStatus
} from "@/lib/onboarding/chat";

describe("onboarding chat helpers", () => {
  it("builds a system prompt that is industry agnostic and md-aware", () => {
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind Services",
      businessType: "hvac_services"
    });

    expect(prompt).toContain("industry agnostic");
    expect(prompt).toContain("assistant profile");
    expect(prompt).toContain("Never mention internal implementation details or file names");
    expect(prompt).toContain("Ask one focused question at a time");
    expect(prompt).toContain("do not use a CRM");
    expect(prompt).toContain("texts, calls, or email");
    expect(prompt).toContain("Answered topic status");
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

  it("includes the crawled website summary as an authoritative section when websiteMd is provided", () => {
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind Services",
      websiteUrl: "https://northwind.example.com",
      websiteMd: "# Northwind Services\n- Heating and cooling repairs"
    });

    expect(prompt).toContain("Website summary (crawled from the user's site, treat as authoritative)");
    expect(prompt).toContain("Heating and cooling repairs");
    expect(prompt).toContain("Do NOT invent facts the summary does not contain");
    // Empty/preview-not-yet-available branch must not also fire when
    // we already have the summary.
    expect(prompt).not.toContain("crawl summary is not yet available");
  });

  it("falls back to a 'we can see the URL' instruction when only websiteUrl is provided (no preview yet)", () => {
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind Services",
      websiteUrl: "https://northwind.example.com"
    });

    expect(prompt).toContain("https://northwind.example.com");
    expect(prompt).toContain("crawl summary is not yet available");
    expect(prompt).toContain('do NOT ask "do you have a website?"');
    expect(prompt).not.toContain("Website summary (crawled");
  });

  it("does not embed the website summary verbatim into the JSON.stringify(knownContext) dump", () => {
    // Bug we're guarding against: dropping `websiteMd` into the raw
    // `Known context: {...}` JSON dump bloats the prompt by ~8KB and
    // mixes a multi-thousand-character markdown blob into a section
    // the model treats as small/scannable. The website content
    // belongs in its own labelled section with explicit usage rules,
    // not inside the JSON dump.
    const summary = "# Long site summary\n" + "- Bullet point\n".repeat(100);
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind",
      websiteUrl: "https://northwind.example.com",
      websiteMd: summary
    });
    const knownContextLine = prompt.split("\n").find((line) => line.startsWith('{"businessName"'));
    expect(knownContextLine, "expected the Known context JSON line to exist").toBeTruthy();
    expect(knownContextLine).not.toContain("Bullet point");
  });

  it("creates an empty assistant profile with blank arrays and strings", () => {
    const profile = createEmptyAssistantProfile();

    expect(profile.businessSummary).toBe("");
    expect(profile.serviceArea).toBe("");
    expect(profile.teamSize).toBe("");
    expect(profile.crmUsed).toEqual([]);
    expect(profile.offerings).toEqual([]);
    expect(profile.inquiryFlows).toEqual([]);
    expect(profile.signature).toBe("");
  });

  it("exports onboarding chat usage caps", () => {
    expect(MAX_ONBOARDING_CHAT_MESSAGES).toBe(36);
    expect(ONBOARDING_CHAT_RATE_LIMIT).toEqual({
      interval: 60_000,
      maxRequests: 12
    });
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
        serviceArea: "Phoenix, AZ",
        teamSize: "4",
        crmUsed: ["ServiceTitan"],
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
    expect(drafts.identityMd).toContain("Service Area: Phoenix, AZ");
    expect(drafts.identityMd).toContain("Team Size: 4");
    expect(drafts.soulMd).toContain("Be calm, clear, and reassuring.");
    expect(drafts.soulMd).toContain("Thanks, Northwind Services");
    expect(drafts.memoryMd).toContain("## Business Summary");
    expect(drafts.memoryMd).toContain("## Customer Types");
    expect(drafts.memoryMd).toContain("ServiceTitan");
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

  it("uses a generic close-out message once the interview is complete", () => {
    expect(finalizeAssistantMessage("Internal draft text", true)).toBe(
      "I have what I need to set up your assistant. You can continue when you're ready."
    );
    expect(finalizeAssistantMessage("One more question", false)).toBe("One more question");
  });

  it("normalizes loose model profile output into the expected shape", () => {
    const parsed = onboardingAssistantProfileSchema.parse({
      businessSummary: "Fast-growing service business",
      serviceArea: "Phoenix Metro",
      teamSize: "6",
      crmUsed: "HubSpot",
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

    expect(parsed.serviceArea).toBe("Phoenix Metro");
    expect(parsed.teamSize).toBe("6");
    expect(parsed.crmUsed).toEqual(["HubSpot"]);
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
      serviceArea: null,
      teamSize: -99,
      crmUsed: "",
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
    expect(parsed.serviceArea).toBe("");
    expect(parsed.teamSize).toBe("");
    expect(parsed.crmUsed).toEqual([]);
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

  it("validates chat messages on the happy path", () => {
    const parsed = onboardingChatMessageSchema.parse({
      role: "user",
      content: "We mostly handle leads by text.",
      timestamp: "2026-03-31T21:00:00.000Z"
    });

    expect(parsed).toEqual({
      role: "user",
      content: "We mostly handle leads by text.",
      timestamp: "2026-03-31T21:00:00.000Z"
    });
  });

  it("rejects invalid chat messages", () => {
    expect(() => onboardingChatMessageSchema.parse({
      role: "system",
      content: "bad role"
    })).toThrow();

    expect(() => onboardingChatMessageSchema.parse({
      role: "assistant",
      content: ""
    })).toThrow();

    expect(() => onboardingChatMessageSchema.parse({
      role: "user",
      content: "valid",
      timestamp: "today"
    })).toThrow();
  });

  it("summarizes answered onboarding topics from profile and transcript", () => {
    const topicStatus = summarizeOnboardingTopicStatus(
      { serviceArea: "", teamSize: "", crmUsed: "" },
      {
        ...createEmptyAssistantProfile(),
        customerTypes: ["First-timers"],
        commonRequests: ["Pricing"],
        tools: []
      },
      [{ role: "user", content: "We just use texts and calls.", timestamp: "2026-03-31T21:00:00.000Z" }]
    );

    expect(topicStatus.toolsKnown).toBe(true);
    expect(topicStatus.customerTypesKnown).toBe(true);
    expect(topicStatus.commonRequestsKnown).toBe(true);
    expect(topicStatus.serviceAreaKnown).toBe(false);
  });

  it("flips teamSizeKnown true when the user transcript answers it, even when the model omits it from the profile", () => {
    // Regression: the model occasionally fails to write `teamSize` into
    // its emitted profile even after the user clearly answered it.
    // Without this transcript fallback the dead-end guard in
    // /api/onboard/chat keeps swapping in the team-size fallback
    // question turn after turn (production case: user said "4 or 5
    // agents" three times before the interview moved on).
    const cases: { content: string; expected: boolean }[] = [
      { content: "4 or 5 agents", expected: true },
      { content: "I have a handful of real estate agents about 4 or 5 on my team", expected: true },
      { content: "I already told you, 4 or 5 team members.", expected: true },
      { content: "4-5 team members", expected: true },
      { content: "Team of 6", expected: true },
      { content: "team of about 12", expected: true },
      { content: "Just me", expected: true },
      { content: "By myself for now", expected: true },
      { content: "Small team", expected: true },
      { content: "a handful of agents", expected: true },
      { content: "3 people on my team", expected: true },
      // Written-out numbers — owners regularly use these in chat
      // ("two staff", "five agents", "team of six"). Comment claims
      // these match; previously they didn't, since `\d+` only covers
      // digits.
      { content: "two staff", expected: true },
      { content: "five agents", expected: true },
      { content: "Team of six", expected: true },
      { content: "team of about ten", expected: true },
      { content: "two people on my team", expected: true },
      { content: "a couple of agents", expected: true },
      { content: "two or three reps", expected: true },
      // Negative cases — the bare numeric/quantifier without a team
      // role noun must not falsely flip teamSizeKnown true.
      { content: "We cover 5 cities", expected: false },
      { content: "I have 12 listings", expected: false },
      { content: "We do 200 closings a year", expected: false },
      // Written-out negatives — the same false-positive class but
      // spelled out ("five years experience" vs "five agents").
      { content: "I have five years experience", expected: false },
      { content: "we serve ten cities", expected: false },
      // Customer-context "people" — these are the cases the previous
      // heuristic false-positived on, causing the assistant to skip
      // asking about actual team size after a customer-volume answer.
      { content: "I help many people buy homes", expected: false },
      { content: "some people text me for quotes", expected: false },
      { content: "I spoke with 3 people today", expected: false },
      { content: "we serve 200 people a month", expected: false }
    ];

    for (const { content, expected } of cases) {
      const topicStatus = summarizeOnboardingTopicStatus(
        { serviceArea: "", teamSize: "", crmUsed: "" },
        createEmptyAssistantProfile(),
        [{ role: "user", content, timestamp: "2026-04-29T17:00:00.000Z" }]
      );
      expect(topicStatus.teamSizeKnown, `for "${content}"`).toBe(expected);
    }
  });

  it("does not flip teamSizeKnown true on assistant messages that mention team-size phrases", () => {
    // The assistant repeatedly RE-ASKS the team size question — that
    // text contains "team" and a number, but it's the exact opposite
    // of a user answer. Only user-role messages should count.
    const topicStatus = summarizeOnboardingTopicStatus(
      { serviceArea: "", teamSize: "", crmUsed: "" },
      createEmptyAssistantProfile(),
      [
        {
          role: "assistant",
          content: "How big is the team — 4 or 5 people, or just you?",
          timestamp: "2026-04-29T17:00:00.000Z"
        }
      ]
    );
    expect(topicStatus.teamSizeKnown).toBe(false);
  });

  it("validates a complete model response on the happy path", () => {
    const parsed = onboardingChatModelResponseSchema.parse({
      assistantMessage: "What kinds of requests do customers usually send you?",
      readyToFinalize: false,
      completionPercent: 35,
      missingTopics: ["routingRules", "toneDirectives"],
      profile: {
        businessSummary: "A local service business that handles inbound leads by phone and text.",
        serviceArea: "Phoenix Metro",
        teamSize: 3,
        crmUsed: [],
        offerings: ["Emergency repair"],
        customerTypes: ["Homeowners"],
        commonRequests: ["Pricing", "Availability"],
        inquiryFlows: [{ trigger: "Customer asks for pricing", responseGoal: "Qualify and move toward booking" }],
        routingRules: ["Route weekend emergencies to the owner"],
        schedulingRules: ["Offer the next available slot"],
        escalationRules: ["Escalate complaints immediately"],
        tools: ["SMS", "Phone"],
        toneDirectives: ["Warm", "Direct"],
        signature: "Thanks, Acme",
        policies: ["Do not promise exact arrival times"],
        factsToRemember: ["Covers Phoenix and Scottsdale"]
      }
    });

    expect(parsed.completionPercent).toBe(35);
    expect(parsed.profile.teamSize).toBe("3");
    expect(parsed.profile.tools).toEqual(["SMS", "Phone"]);
  });

  it("accepts incomplete model responses when profile fields are omitted", () => {
    const parsed = onboardingChatModelResponseSchema.parse({
      assistantMessage: "What area do you serve?",
      readyToFinalize: false,
      completionPercent: 10,
      missingTopics: [],
      profile: {}
    });

    expect(parsed.profile).toEqual(createEmptyAssistantProfile());
  });

  it("normalizes loose top-level model response fields", () => {
    const parsed = onboardingChatModelResponseSchema.parse({
      assistantMessage: "  What geographic area do you serve?  ",
      readyToFinalize: "yes",
      completionPercent: "55",
      missingTopics: "routingRules",
      profile: null
    });

    expect(parsed.assistantMessage).toBe("What geographic area do you serve?");
    expect(parsed.readyToFinalize).toBe(true);
    expect(parsed.completionPercent).toBe(55);
    expect(parsed.missingTopics).toEqual(["routingRules"]);
    expect(parsed.profile).toEqual(createEmptyAssistantProfile());
  });

  it("defaults missing or invalid top-level response fields to safe values", () => {
    const parsed = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: undefined,
      completionPercent: "not-a-number",
      missingTopics: undefined,
      profile: "bad"
    });

    expect(parsed.readyToFinalize).toBe(false);
    expect(parsed.completionPercent).toBe(0);
    expect(parsed.missingTopics).toEqual([]);
    expect(parsed.profile).toEqual(createEmptyAssistantProfile());
  });

  it("normalizes boolean-like top-level flags from strings and numbers", () => {
    const stringFalse = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: "no",
      completionPercent: 20,
      missingTopics: [],
      profile: {}
    });
    const blankFalse = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: "",
      completionPercent: 20,
      missingTopics: [],
      profile: {}
    });
    const stringLiteralFalse = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: "false",
      completionPercent: 20,
      missingTopics: [],
      profile: {}
    });
    const numericTrue = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: 1,
      completionPercent: 20,
      missingTopics: [],
      profile: {}
    });

    expect(stringFalse.readyToFinalize).toBe(false);
    expect(blankFalse.readyToFinalize).toBe(false);
    expect(stringLiteralFalse.readyToFinalize).toBe(false);
    expect(numericTrue.readyToFinalize).toBe(true);
  });

  it("clamps out-of-range completion percent values", () => {
    const belowZero = onboardingChatModelResponseSchema.parse({
      assistantMessage: "bad",
      readyToFinalize: false,
      completionPercent: -1,
      missingTopics: [],
      profile: {}
    });

    const aboveHundred = onboardingChatModelResponseSchema.parse({
      assistantMessage: "bad",
      readyToFinalize: false,
      completionPercent: 101,
      missingTopics: [],
      profile: {}
    });

    expect(belowZero.completionPercent).toBe(0);
    expect(aboveHundred.completionPercent).toBe(100);
  });

  it("defaults blank-string completion percent values to zero", () => {
    const parsed = onboardingChatModelResponseSchema.parse({
      assistantMessage: "Next question",
      readyToFinalize: false,
      completionPercent: "   ",
      missingTopics: [],
      profile: {}
    });

    expect(parsed.completionPercent).toBe(0);
  });

  it("still rejects model responses without an assistant message", () => {
    expect(() => onboardingChatModelResponseSchema.parse({
      assistantMessage: "",
      readyToFinalize: "no",
      completionPercent: 20,
      missingTopics: "routingRules",
      profile: {}
    })).toThrow();
  });

  it("rejects model responses when assistantMessage is not a string", () => {
    expect(() => onboardingChatModelResponseSchema.parse({
      assistantMessage: 123,
      readyToFinalize: false,
      completionPercent: 20,
      missingTopics: [],
      profile: {}
    })).toThrow();
  });

  it("normalizes negative and invalid team sizes to empty", () => {
    const negative = onboardingAssistantProfileSchema.parse({
      ...createEmptyAssistantProfile(),
      teamSize: -3
    });
    const text = onboardingAssistantProfileSchema.parse({
      ...createEmptyAssistantProfile(),
      teamSize: "many"
    });

    expect(negative.teamSize).toBe("");
    expect(text.teamSize).toBe("");
  });

  it("keeps zero and positive integer team sizes", () => {
    const zero = onboardingAssistantProfileSchema.parse({
      ...createEmptyAssistantProfile(),
      teamSize: 0
    });
    const positive = onboardingAssistantProfileSchema.parse({
      ...createEmptyAssistantProfile(),
      teamSize: "12"
    });

    expect(zero.teamSize).toBe("0");
    expect(positive.teamSize).toBe("12");
  });
});
