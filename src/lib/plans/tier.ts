export type PlanTier = "starter" | "standard" | "enterprise";

export type PlanPricing = {
  monthlyCents: number;
  setupCents: number;
};

const PRICING: Record<PlanTier, PlanPricing> = {
  starter: { monthlyCents: 19900, setupCents: 0 },
  standard: { monthlyCents: 29900, setupCents: 49900 },
  enterprise: { monthlyCents: 0, setupCents: 0 }
};

export function getTierPricing(tier: PlanTier): PlanPricing {
  return PRICING[tier];
}

export function isPaidTier(tier: PlanTier): boolean {
  return tier !== "enterprise";
}
