import { describe, expect, it } from "vitest";
import {
  areAllChatTopicsCovered,
  buildOnboardingChatSystemPrompt,
  CHAT_ELICITED_TOPIC_KEYS,
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
    // CRM-as-tools fallback — wording shifted post-Step-1 migration
    // ("None — texts, email, or calendar only" is the canonical
    // dropdown value), but the underlying instruction (treat no
    // formal CRM as a valid answer, not a gap) is still present.
    expect(prompt).toContain("no formal CRM");
    expect(prompt).toContain("None — texts, email, or calendar only");
    expect(prompt).toContain("Answered topic status");
  });

  it("instructs the model NOT to re-ask service area / team size / CRM (Step 1 form-collected)", () => {
    // Service area, team size, and CRM/tools moved from Step 2 chat
    // elicitation to Step 1 closed-class form fields. The chat
    // system prompt must explicitly tell the model those values in
    // `knownContext` are authoritative — re-asking them after the
    // user already filled out the form reads as the assistant
    // ignoring the user (the same UX failure that drove the original
    // dead-end fallback work). Tests the literal contract because
    // softer wording would let prompt regressions slip in unnoticed.
    const prompt = buildOnboardingChatSystemPrompt({
      businessName: "Northwind Services",
      serviceArea: "Phoenix metro, AZ",
      teamSize: "4-5",
      crmUsed: "Follow Up Boss"
    });
    expect(prompt).toContain("collected on the Step 1 form");
    expect(prompt).toContain("do NOT re-ask those topics");
    // The prompt also dumps knownContext as JSON — sanity check that
    // the form-collected values arrive there so the model can see
    // them.
    expect(prompt).toContain("Phoenix metro, AZ");
    expect(prompt).toContain("4-5");
    expect(prompt).toContain("Follow Up Boss");
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

  it("summarizes the chat-elicited topics from the profile alone (no knownContext / transcript inputs)", () => {
    // Service area / team size / CRM are collected on the Step 1
    // form and never feed into the chat-side topic status — the
    // summary function takes only the profile. Pinning the
    // resulting object's exact shape locks the migration: no
    // future code path should leak `serviceAreaKnown`,
    // `teamSizeKnown`, or `toolsKnown` keys back in.
    const topicStatus = summarizeOnboardingTopicStatus({
      ...createEmptyAssistantProfile(),
      customerTypes: ["First-timers"],
      commonRequests: ["Pricing"],
      inquiryFlows: [{ trigger: "buyer DM", responseGoal: "ask budget" }],
      routingRules: ["Send Phoenix listings to Jason"],
      toneDirectives: ["Warm and concise"]
    });

    expect(topicStatus).toEqual({
      customerTypesKnown: true,
      commonRequestsKnown: true,
      inquiryFlowsKnown: true,
      routingRulesKnown: true,
      toneKnown: true
    });
  });

  it("derives toneKnown true from a non-empty signature alone (escalationRules also satisfies routingRulesKnown)", () => {
    // The two OR clauses inside summarizeOnboardingTopicStatus —
    // toneKnown via signature, routingRulesKnown via
    // escalationRules — would otherwise go uncovered if every test
    // populated the primary branch.
    const topicStatus = summarizeOnboardingTopicStatus({
      ...createEmptyAssistantProfile(),
      escalationRules: ["Escalate legal questions to the broker"],
      signature: "Sunrise Realty"
    });
    expect(topicStatus.routingRulesKnown).toBe(true);
    expect(topicStatus.toneKnown).toBe(true);
  });

  it("returns all-false on an empty profile (no chat answers yet)", () => {
    expect(summarizeOnboardingTopicStatus(createEmptyAssistantProfile())).toEqual({
      customerTypesKnown: false,
      commonRequestsKnown: false,
      inquiryFlowsKnown: false,
      routingRulesKnown: false,
      toneKnown: false
    });
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

describe("CHAT_ELICITED_TOPIC_KEYS / areAllChatTopicsCovered", () => {
  // The post-Step-1-migration shape of `OnboardingTopicStatus` was
  // shrunk to only chat-elicited keys (service area / team size /
  // CRM are collected on Step 1 and never feed back into chat-side
  // logic). These tests pin the resulting public contract: the
  // tuple must list exactly the 5 chat keys, and the predicate must
  // be the conjunction of those 5 booleans.

  function makeTopicStatus(overrides: Partial<Record<string, boolean>> = {}) {
    return {
      customerTypesKnown: false,
      commonRequestsKnown: false,
      inquiryFlowsKnown: false,
      routingRulesKnown: false,
      toneKnown: false,
      ...overrides
    };
  }

  it("exposes exactly the 5 chat-elicited keys in declared order", () => {
    // Order matters because `createFallbackAssistantQuestion` walks
    // these in priority sequence — pinning it prevents accidental
    // reordering from changing which question fires when multiple
    // topics are uncovered.
    expect([...CHAT_ELICITED_TOPIC_KEYS]).toEqual([
      "customerTypesKnown",
      "commonRequestsKnown",
      "inquiryFlowsKnown",
      "routingRulesKnown",
      "toneKnown"
    ]);
  });

  it("returns true when every chat-elicited topic is covered", () => {
    expect(
      areAllChatTopicsCovered(
        makeTopicStatus({
          customerTypesKnown: true,
          commonRequestsKnown: true,
          inquiryFlowsKnown: true,
          routingRulesKnown: true,
          toneKnown: true
        })
      )
    ).toBe(true);
  });

  it("returns false when any chat-elicited topic is still uncovered", () => {
    // Each key independently blocks finalization. Iterating over
    // `CHAT_ELICITED_TOPIC_KEYS` (rather than hand-listing) means
    // adding a new chat-elicited topic in the future automatically
    // grows the test surface, so a dropped key in the conjunction
    // would surface here.
    for (const blockingKey of CHAT_ELICITED_TOPIC_KEYS) {
      const allCovered = Object.fromEntries(
        CHAT_ELICITED_TOPIC_KEYS.map((key) => [key, true])
      );
      expect(
        areAllChatTopicsCovered(
          makeTopicStatus({ ...allCovered, [blockingKey]: false })
        ),
        `expected false when only ${blockingKey} is uncovered`
      ).toBe(false);
    }
  });
});
