import type { BillingPeriod } from "@/lib/plans/tier";
import type {
  OnboardingAssistantProfile,
  OnboardingChatMessage,
  RowboatMarkdownDrafts
} from "@/lib/onboarding/chat";

export const ONBOARD_STORAGE_KEY = "newcoworker_onboard";

/** Questionnaire step/form autosave (see /onboard/questionnaire). */
export const DRAFT_STORAGE_KEY = "newcoworker_onboard_draft";

/**
 * Remove every onboarding artifact from localStorage. Called at the
 * onboarding → dashboard handoff on /onboard/success: a draft left behind
 * carries a resumable `businessId`, and resuming it months later from a
 * signed-in browser once re-onboarded ON TOP of a live business (overwrote
 * its agent config and shadowed its active subscription). Client-side only.
 */
export function clearOnboardingStorage(): void {
  try {
    localStorage.removeItem(ONBOARD_STORAGE_KEY);
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, disabled) — the server-side
    // checkout guard is the hard stop; this cleanup is best-effort.
  }
}

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
  /** Optional signup-chosen area code for the AI coworker's number. */
  preferredAreaCode?: string;
  websiteUrl?: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
  assistantChat?: OnboardingAssistantChatState;
};
