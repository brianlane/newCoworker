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

type AuthOnboardingSource = Partial<AuthOnboardingSnapshot>;

export function buildSignupAuthMetadata(
  businessName: string,
  onboardingData: AuthOnboardingSource | null | undefined
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

  if (
    onboardingData.tier &&
    onboardingData.billingPeriod &&
    onboardingData.businessName !== undefined &&
    onboardingData.businessType !== undefined &&
    onboardingData.ownerName !== undefined &&
    onboardingData.phone !== undefined &&
    onboardingData.serviceArea !== undefined &&
    onboardingData.teamSize !== undefined &&
    onboardingData.crmUsed !== undefined
  ) {
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
  }

  return metadata;
}
