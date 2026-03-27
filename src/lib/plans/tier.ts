export type PlanTier = "starter" | "standard" | "enterprise";

export type BillingPeriod = "monthly" | "annual" | "biennial";

export type PeriodPricing = {
  monthlyCents: number;
  renewalMonthlyCents: number;
};

export type PlanPricing = {
  setupCents: number;
  periods: Record<BillingPeriod, PeriodPricing>;
  cancelWindowDays: number;
};

const PRICING: Record<PlanTier, PlanPricing> = {
  starter: {
    setupCents: 0,
    cancelWindowDays: 30,
    periods: {
      biennial: { monthlyCents: 999, renewalMonthlyCents: 1699 },
      annual: { monthlyCents: 1099, renewalMonthlyCents: 1899 },
      monthly: { monthlyCents: 1599, renewalMonthlyCents: 2699 }
    }
  },
  standard: {
    setupCents: 0,
    cancelWindowDays: 30,
    periods: {
      biennial: { monthlyCents: 9900, renewalMonthlyCents: 18900 },
      annual: { monthlyCents: 10900, renewalMonthlyCents: 20900 },
      monthly: { monthlyCents: 19500, renewalMonthlyCents: 27900 }
    }
  },
  enterprise: {
    setupCents: 0,
    cancelWindowDays: 0,
    periods: {
      biennial: { monthlyCents: 0, renewalMonthlyCents: 0 },
      annual: { monthlyCents: 0, renewalMonthlyCents: 0 },
      monthly: { monthlyCents: 0, renewalMonthlyCents: 0 }
    }
  }
};

export function getTierPricing(tier: PlanTier): PlanPricing {
  return PRICING[tier];
}

export function getPeriodPricing(
  tier: PlanTier,
  period: BillingPeriod
): PeriodPricing {
  return PRICING[tier].periods[period];
}

export function getCommitmentMonths(period: BillingPeriod): number {
  const months: Record<BillingPeriod, number> = {
    biennial: 24,
    annual: 12,
    monthly: 1
  };
  return months[period];
}

export function isPaidTier(tier: PlanTier): boolean {
  return tier !== "enterprise";
}
