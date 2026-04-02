import type { OnboardingData } from "@/lib/onboarding/storage";

type AuthOnboardingSnapshot = Pick<
  OnboardingData,
  | "tier"
  | "billingPeriod"
  | "businessName"
  | "businessType"
  | "ownerName"
  | "ownerEmail"
  | "phone"
  | "serviceArea"
  | "teamSize"
  | "crmUsed"
>;

export function buildSignupAuthMetadata(
  businessName: string,
  onboardingData: OnboardingData | null | undefined
) {
  const metadata: {
    business_name: string;
    onboarding_data?: AuthOnboardingSnapshot;
  } = {
    business_name: businessName
  };

  if (!onboardingData) {
    return metadata;
  }

  metadata.onboarding_data = {
    tier: onboardingData.tier,
    billingPeriod: onboardingData.billingPeriod,
    businessName: onboardingData.businessName,
    businessType: onboardingData.businessType,
    ownerName: onboardingData.ownerName,
    ownerEmail: onboardingData.ownerEmail,
    phone: onboardingData.phone,
    serviceArea: onboardingData.serviceArea,
    teamSize: onboardingData.teamSize,
    crmUsed: onboardingData.crmUsed
  };

  return metadata;
}
