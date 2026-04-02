import type { BillingPeriod } from "@/lib/plans/tier";
import type {
  OnboardingAssistantProfile,
  OnboardingChatMessage,
  RowboatMarkdownDrafts
} from "@/lib/onboarding/chat";

export const ONBOARD_STORAGE_KEY = "newcoworker_onboard";

export type OnboardingAssistantChatDraftState = {
  messages: OnboardingChatMessage[];
  readyToFinalize: boolean;
  completionPercent: number;
  missingTopics: string[];
  profile: OnboardingAssistantProfile;
  drafts: RowboatMarkdownDrafts;
};

export type OnboardingAssistantChatState = {
  readyToFinalize: boolean;
  completionPercent: number;
  profile: OnboardingAssistantProfile;
  drafts: RowboatMarkdownDrafts;
};

export type OnboardingData = {
  businessId?: string;
  draftToken?: string;
  onboardingToken?: string;
  ownerEmail?: string;
  signupUserId?: string;
  persistedToDatabase?: boolean;
  tier: "starter" | "standard";
  billingPeriod: BillingPeriod;
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
  assistantChat?: OnboardingAssistantChatState;
};
