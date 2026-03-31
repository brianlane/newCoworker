import { z } from "zod";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeInquiryFlows(value: unknown): { trigger: string; responseGoal: string }[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const trigger = "trigger" in item && typeof item.trigger === "string" ? item.trigger : "";
    const responseGoal = "responseGoal" in item && typeof item.responseGoal === "string" ? item.responseGoal : "";
    return trigger || responseGoal ? [{ trigger, responseGoal }] : [];
  });
}

export const onboardingChatMessageSchema = z.object({
  role: z.enum(["assistant", "user"]),
  content: z.string().min(1)
});

export const onboardingInquiryFlowSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return { trigger: "", responseGoal: "" };
    return {
      trigger: "trigger" in value && typeof value.trigger === "string" ? value.trigger : "",
      responseGoal: "responseGoal" in value && typeof value.responseGoal === "string" ? value.responseGoal : ""
    };
  },
  z.object({
    trigger: z.string(),
    responseGoal: z.string()
  })
);

export const onboardingAssistantProfileSchema = z.object({
  businessSummary: z.preprocess(normalizeString, z.string()),
  offerings: z.preprocess(normalizeStringArray, z.array(z.string())),
  customerTypes: z.preprocess(normalizeStringArray, z.array(z.string())),
  commonRequests: z.preprocess(normalizeStringArray, z.array(z.string())),
  inquiryFlows: z.preprocess(normalizeInquiryFlows, z.array(onboardingInquiryFlowSchema)),
  routingRules: z.preprocess(normalizeStringArray, z.array(z.string())),
  schedulingRules: z.preprocess(normalizeStringArray, z.array(z.string())),
  escalationRules: z.preprocess(normalizeStringArray, z.array(z.string())),
  tools: z.preprocess(normalizeStringArray, z.array(z.string())),
  toneDirectives: z.preprocess(normalizeStringArray, z.array(z.string())),
  signature: z.preprocess(normalizeString, z.string()),
  policies: z.preprocess(normalizeStringArray, z.array(z.string())),
  factsToRemember: z.preprocess(normalizeStringArray, z.array(z.string()))
});

export const onboardingChatModelResponseSchema = z.object({
  assistantMessage: z.string().min(1),
  readyToFinalize: z.boolean(),
  completionPercent: z.number().min(0).max(100),
  missingTopics: z.array(z.string()),
  profile: onboardingAssistantProfileSchema
});

export type OnboardingChatMessage = z.infer<typeof onboardingChatMessageSchema>;
export type OnboardingAssistantProfile = z.infer<typeof onboardingAssistantProfileSchema>;
export type OnboardingChatModelResponse = z.infer<typeof onboardingChatModelResponseSchema>;

export type RowboatMarkdownDrafts = {
  identityMd: string;
  soulMd: string;
  memoryMd: string;
};

export type OnboardingKnownContext = {
  businessName?: string;
  businessType?: string;
  ownerName?: string;
  phone?: string;
  serviceArea?: string;
  teamSize?: string;
  crmUsed?: string;
};

export function createEmptyAssistantProfile(): OnboardingAssistantProfile {
  return {
    businessSummary: "",
    offerings: [],
    customerTypes: [],
    commonRequests: [],
    inquiryFlows: [],
    routingRules: [],
    schedulingRules: [],
    escalationRules: [],
    tools: [],
    toneDirectives: [],
    signature: "",
    policies: [],
    factsToRemember: []
  };
}

function listOrFallback(items: string[], fallback: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function trimLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function humanizeSlug(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildOnboardingChatSystemPrompt(
  knownContext: OnboardingKnownContext,
  existingProfile?: OnboardingAssistantProfile | null
): string {
  const profile = existingProfile ?? createEmptyAssistantProfile();

  return [
    "You are a high-signal onboarding interviewer for creating a Rowboat/OpenClaw-style business assistant.",
    "Your job is to gather the information needed to produce strong SOUL.md, IDENTITY.md, and MEMORY.md files.",
    "Be industry agnostic. Do not assume real estate unless the user says so. Industry-specific examples are allowed only to steer the user when helpful.",
    "Ask one focused question at a time. Keep assistant replies concise, practical, and easy to answer.",
    "Prefer collecting cause/effect communication patterns, routing rules, escalation rules, FAQ facts, tool context, and tone guidance over generic marketing copy.",
    "Do not ask for technical integration setup in detail during onboarding. Gmail, calendar, CRM, and OAuth tooling can be captured as current-tool context only.",
    "Ask for service area, market, or territory early unless it is already known in context.",
    "If the user gives vague answers, ask for one or two concrete examples.",
    "Update the profile using the conversation and the known context below. Preserve useful prior details; do not erase good data.",
    "Return JSON only.",
    "",
    "Known context:",
    JSON.stringify(knownContext),
    "",
    "Existing profile:",
    JSON.stringify(profile),
    "",
    "Return an object with exactly these keys:",
    "- assistantMessage: string",
    "- readyToFinalize: boolean",
    "- completionPercent: number 0-100",
    "- missingTopics: string[]",
    "- profile: { businessSummary, offerings, customerTypes, commonRequests, inquiryFlows[{trigger,responseGoal}], routingRules, schedulingRules, escalationRules, tools, toneDirectives, signature, policies, factsToRemember }",
    "",
    "Mark readyToFinalize true only when you have enough information to draft a useful business assistant without obvious gaps."
  ].join("\n");
}

export function compileIdentityMd(
  knownContext: OnboardingKnownContext,
  profile: OnboardingAssistantProfile
): string {
  const businessName = trimLine(knownContext.businessName || "Unknown Business");
  const businessType = trimLine(knownContext.businessType ? humanizeSlug(knownContext.businessType) : "unspecified");
  const ownerName = trimLine(knownContext.ownerName || "unspecified");
  const phone = trimLine(knownContext.phone || "unspecified");
  const serviceArea = trimLine(knownContext.serviceArea || "unspecified");
  const teamSize = trimLine(knownContext.teamSize || "unspecified");

  return [
    "# identity.md",
    `Business Name: ${businessName}`,
    `Industry: ${businessType}`,
    `Owner / Primary Contact: ${ownerName}`,
    `Business Phone: ${phone}`,
    `Service Area: ${serviceArea}`,
    `Team Size: ${teamSize}`,
    "",
    "## Snapshot",
    profile.businessSummary ? profile.businessSummary : "Business context still being collected.",
    "",
    "## Offerings",
    listOrFallback(profile.offerings, "Offerings not captured yet."),
    "",
    "## Customer Types",
    listOrFallback(profile.customerTypes, "Customer types not captured yet.")
  ].join("\n");
}

export function compileSoulMd(profile: OnboardingAssistantProfile): string {
  return [
    "# soul.md",
    "You are a professional AI coworker representing the business with accuracy, clarity, and good judgment.",
    "",
    "## Communication Style",
    listOrFallback(profile.toneDirectives, "Use a professional, helpful, and concise tone."),
    "",
    "## Response Goals",
    listOrFallback(profile.commonRequests, "Handle common inbound questions and move conversations toward a useful next step."),
    "",
    "## Routing Rules",
    listOrFallback(profile.routingRules, "Route to the correct team member when the business has a clear owner or specialist."),
    "",
    "## Escalation Rules",
    listOrFallback(profile.escalationRules, "Escalate sensitive or ambiguous situations to a human."),
    "",
    "## Policies / Boundaries",
    listOrFallback(profile.policies, "Do not invent business policies. If uncertain, say so and offer a follow-up."),
    "",
    "## Signature",
    profile.signature ? `Use this sign-off when appropriate: ${profile.signature}` : "Use the business's preferred sign-off when one is provided."
  ].join("\n");
}

export function compileMemoryMd(
  knownContext: OnboardingKnownContext,
  profile: OnboardingAssistantProfile
): string {
  const flowLines = profile.inquiryFlows.length > 0
    ? profile.inquiryFlows.map((flow) => `- Cause: ${flow.trigger}\n  Effect: ${flow.responseGoal}`).join("\n")
    : "- No concrete inquiry flows captured yet.";

  return [
    "# memory.md",
    `Business: ${trimLine(knownContext.businessName || "Unknown Business")}`,
    "",
    "## Business Summary",
    profile.businessSummary ? profile.businessSummary : "Business summary not captured yet.",
    "",
    "## Customer Types",
    listOrFallback(profile.customerTypes, "No customer types captured yet."),
    "",
    "## Facts To Remember",
    listOrFallback(profile.factsToRemember, "No durable facts captured yet."),
    "",
    "## Tools In Use",
    listOrFallback(profile.tools, "No tools captured yet."),
    "",
    "## Scheduling Rules",
    listOrFallback(profile.schedulingRules, "No scheduling rules captured yet."),
    "",
    "## Inquiry Playbooks",
    flowLines,
    "",
    "## FAQ / Common Requests",
    listOrFallback(profile.commonRequests, "No FAQs captured yet.")
  ].join("\n");
}

export function compileRowboatMarkdownDrafts(
  knownContext: OnboardingKnownContext,
  profile: OnboardingAssistantProfile
): RowboatMarkdownDrafts {
  return {
    identityMd: compileIdentityMd(knownContext, profile),
    soulMd: compileSoulMd(profile),
    memoryMd: compileMemoryMd(knownContext, profile)
  };
}
