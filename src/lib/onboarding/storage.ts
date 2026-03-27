import type { BillingPeriod } from "@/lib/plans/tier";

export const ONBOARD_STORAGE_KEY = "newcoworker_onboard";

export type OnboardingData = {
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
};
