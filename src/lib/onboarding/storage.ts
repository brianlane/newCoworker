export const ONBOARD_STORAGE_KEY = "newcoworker_onboard";

export type OnboardingData = {
  tier: "starter" | "standard";
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
};
