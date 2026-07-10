import { z } from "zod";
import { buildComplianceSystemPrompt } from "@/lib/compliance/fha";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeCountString(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") return "";

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return "";
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return ["true", "yes", "y", "1"].includes(trimmed);
  }
  return false;
}

function normalizeCompletionPercent(value: unknown): number {
  const raw = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
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
  content: z.string().min(1),
  timestamp: z.string().datetime().optional()
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
  serviceArea: z.preprocess(normalizeString, z.string()),
  teamSize: z.preprocess(normalizeCountString, z.string()),
  crmUsed: z.preprocess(normalizeStringArray, z.array(z.string())),
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
  assistantMessage: z.preprocess(normalizeNonEmptyString, z.string().min(1)),
  readyToFinalize: z.preprocess(normalizeBoolean, z.boolean()),
  completionPercent: z.preprocess(normalizeCompletionPercent, z.number().min(0).max(100)),
  missingTopics: z.preprocess(normalizeStringArray, z.array(z.string())),
  profile: z.preprocess(
    (value) => (value && typeof value === "object" ? value : {}),
    onboardingAssistantProfileSchema
  )
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
  /**
   * The user's website URL as entered on Step 1. Surfaced to the
   * onboarding model so it can acknowledge the URL even when the
   * stateless preview ingest hasn't returned `websiteMd` yet (or
   * couldn't crawl the page). Without this the model asks "do you
   * have a website?" right after the user pasted it, which reads as
   * the assistant ignoring the user.
   */
  websiteUrl?: string;
  /**
   * Crawler-and-summarizer output from `/api/onboard/website-preview`,
   * cached on the client across Step-2 chat turns. Capped to
   * `WEBSITE_INGEST_MAX_SUMMARY_CHARS` upstream. The model is allowed
   * to reference this content but must not fabricate facts beyond it.
   */
  websiteMd?: string;
};

export const MAX_ONBOARDING_CHAT_MESSAGES = 36;
export const ONBOARDING_CHAT_RATE_LIMIT = {
  interval: 60 * 1000,
  maxRequests: 12
} as const;

/**
 * Topic coverage for the chat-elicited subset of the onboarding
 * brief. Service area, team size, and CRM/tools are NOT here —
 * they're collected on the Step 1 form (closed-class dropdowns,
 * validated before advance) and arrive in `knownContext` directly.
 * Including them here once meant we shipped an entire team-size
 * transcript-detection regex chain (~150 LoC) and a Q/A-pairing
 * disqualifier purely to retro-fit the chat output back into
 * `knownContext.teamSize` — work that the form now does for free.
 */
type OnboardingTopicStatus = {
  customerTypesKnown: boolean;
  commonRequestsKnown: boolean;
  inquiryFlowsKnown: boolean;
  routingRulesKnown: boolean;
  toneKnown: boolean;
};

/**
 * Public list of the topic-status keys, exported as a closed-class
 * tuple so external consumers (route-level dead-end logic, tests)
 * can iterate without re-inventing the contract. Pinning this in a
 * test prevents future migrations from silently regressing back to
 * the form-vs-chat split that caused the legacy-draft finalize loop.
 */
export const CHAT_ELICITED_TOPIC_KEYS = [
  "customerTypesKnown",
  "commonRequestsKnown",
  "inquiryFlowsKnown",
  "routingRulesKnown",
  "toneKnown"
] as const satisfies readonly (keyof OnboardingTopicStatus)[];

/**
 * True when every chat-elicited topic has been answered. Used by the
 * dead-end guard in `/api/onboard/chat` to decide between
 * auto-finalizing and emitting a fallback question.
 */
export function areAllChatTopicsCovered(topicStatus: OnboardingTopicStatus): boolean {
  return CHAT_ELICITED_TOPIC_KEYS.every((key) => topicStatus[key]);
}

/**
 * Pattern shared with `/api/onboard/chat`'s
 * `shouldSuppressRepeatedToolsQuestion` so the route can count
 * tool-mentioning user messages and suppress repeat tools-questions
 * without re-defining the lexicon. Lives here because it's also part
 * of the user-facing onboarding vocabulary.
 */
export const TOOL_SIGNAL_PATTERN =
  /\b(text|texts|sms|call|calls|phone|phones|gmail|email|emails|calendar|calendly|vagaro|crm|hubspot|pipeline|imessage)\b/i;

export function summarizeOnboardingTopicStatus(
  profile: OnboardingAssistantProfile
): OnboardingTopicStatus {
  return {
    customerTypesKnown: profile.customerTypes.length > 0,
    commonRequestsKnown: profile.commonRequests.length > 0,
    inquiryFlowsKnown: profile.inquiryFlows.length > 0,
    routingRulesKnown: profile.routingRules.length > 0 || profile.escalationRules.length > 0,
    toneKnown: profile.toneDirectives.length > 0 || Boolean(profile.signature.trim())
  };
}

export function createEmptyAssistantProfile(): OnboardingAssistantProfile {
  return {
    businessSummary: "",
    serviceArea: "",
    teamSize: "",
    crmUsed: [],
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
  const topicStatus = summarizeOnboardingTopicStatus(profile);

  // The full website summary can be ~8KB and is the dominant component
  // of the system prompt's size when present. Pull it out of
  // `knownContext` for the JSON dump so the rest of the context stays
  // small/scannable for the model, then re-attach the website summary
  // as its own labelled section with explicit usage rules.
  const { websiteMd, ...contextWithoutWebsite } = knownContext;

  const websiteSection = websiteMd
    ? [
        "",
        "Website summary (crawled from the user's site, treat as authoritative):",
        websiteMd,
        "",
        "When the user references their website or asks the assistant to use info from it, draw from the summary above instead of asking the user to retype it. Do NOT invent facts the summary does not contain. If the summary lacks the specific detail you need, ask the user directly."
      ].join("\n")
    : knownContext.websiteUrl
      ? [
          "",
          `The user has a website at ${knownContext.websiteUrl} but the crawl summary is not yet available. Acknowledge that you can see the URL — do NOT ask "do you have a website?" — and ask for whatever specific detail you need (bio, services, hours) instead of asking the user to retype the URL.`
        ].join("\n")
      : "";

  return [
    "You are a high-signal onboarding interviewer for creating a Rowboat/OpenClaw-style business assistant.",
    "Your job is to gather the information needed to produce a strong assistant profile and business memory.",
    "Be industry agnostic. Do not assume real estate unless the user says so. Industry-specific examples are allowed only to steer the user when helpful.",
    "Ask one focused question at a time. Keep assistant replies concise, practical, and easy to answer.",
    "Prefer collecting cause/effect communication patterns, routing rules, escalation rules, FAQ facts, and tone guidance over generic marketing copy.",
    "Do not ask for technical integration setup in detail during onboarding. Gmail, calendar, CRM, and OAuth tooling can be captured as current-tool context only.",
    "Never mention internal implementation details or file names like SOUL.md, IDENTITY.md, MEMORY.md, markdown files, knowledge base files, or technical setup artifacts in assistantMessage.",
    // Service area / team size / CRM are collected on the Step 1
    // form as closed-class fields (segmented control + dropdown +
    // validated text). They arrive in `knownContext` already
    // answered; re-asking them in chat reads as the assistant
    // ignoring the user. Only if `knownContext` is missing one of
    // them (legacy localStorage drafts that pre-date the Step 1
    // fields) is it acceptable to confirm the answer in chat — and
    // even then, ask once and move on.
    "Service area, team size, and CRM/tools are collected on the Step 1 form. The values in `knownContext.{serviceArea,teamSize,crmUsed}` are authoritative — do NOT re-ask those topics. If a value is empty in `knownContext`, treat it as the user choosing not to specify and skip past it rather than re-asking.",
    "If the user has no formal CRM (e.g. `knownContext.crmUsed` says \"None — texts, email, or calendar only\"), keep `profile.crmUsed` empty and capture the real operating tools under `tools` and `factsToRemember` instead.",
    "If the user gives vague answers, ask for one or two concrete examples.",
    "Never ask for information that is already known in the existing profile, known context, or transcript. If a topic is already answered, move to the next missing topic instead of re-asking it.",
    "Update the profile using the conversation and the known context below. Preserve useful prior details; do not erase good data.",
    "Return JSON only.",
    "",
    "Known context:",
    JSON.stringify(contextWithoutWebsite),
    "",
    "Existing profile:",
    JSON.stringify(profile),
    "",
    "Answered topic status:",
    JSON.stringify(topicStatus),
    websiteSection,
    "",
    "Return an object with exactly these keys:",
    "- assistantMessage: string",
    "- readyToFinalize: boolean",
    "- completionPercent: number 0-100",
    "- missingTopics: string[]",
    "- profile: { businessSummary, serviceArea, teamSize, crmUsed, offerings, customerTypes, commonRequests, inquiryFlows[{trigger,responseGoal}], routingRules, schedulingRules, escalationRules, tools, toneDirectives, signature, policies, factsToRemember }",
    "",
    "Mark readyToFinalize true only when you have enough information to draft a useful business assistant without obvious gaps.",
    "When readyToFinalize is true, assistantMessage should briefly confirm that you have what you need and tell the user they can continue.",
    "When readyToFinalize is false, the LAST sentence of assistantMessage MUST be a single concrete question that ends with a question mark. Do not summarize what you have unless it is followed by that question.",
    "When readyToFinalize is false, NEVER write phrases like 'you can continue', 'answer the next question', 'ready to finalize soon', 'almost done', or any similar wording that implies the interview is wrapping up. Either ask the next concrete question or set readyToFinalize true — never both, and never neither."
  ].join("\n");
}

export function finalizeAssistantMessage(assistantMessage: string, readyToFinalize: boolean): string {
  if (!readyToFinalize) {
    return assistantMessage;
  }

  return "I have what I need to set up your assistant. You can continue when you're ready.";
}

export function compileIdentityMd(
  knownContext: OnboardingKnownContext,
  profile: OnboardingAssistantProfile
): string {
  const businessName = trimLine(knownContext.businessName || "Unknown Business");
  const businessType = trimLine(knownContext.businessType ? humanizeSlug(knownContext.businessType) : "unspecified");
  const ownerName = trimLine(knownContext.ownerName || "unspecified");
  const phone = trimLine(knownContext.phone || "unspecified");
  const serviceArea = trimLine(knownContext.serviceArea || profile.serviceArea || "unspecified");
  const teamSize = trimLine(knownContext.teamSize || profile.teamSize || "unspecified");

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

export function compileSoulMd(
  profile: OnboardingAssistantProfile,
  businessType?: string | null
): string {
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
    "## Compliance",
    buildComplianceSystemPrompt(businessType),
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
    listOrFallback(
      [...profile.crmUsed, ...profile.tools].filter((value, index, all) => all.indexOf(value) === index),
      "No tools captured yet."
    ),
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
    soulMd: compileSoulMd(profile, knownContext.businessType),
    memoryMd: compileMemoryMd(knownContext, profile)
  };
}
