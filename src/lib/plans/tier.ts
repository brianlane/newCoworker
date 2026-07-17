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
      // Biennial renewal bumped $16.99 → $19.99 in the Jul 2026 tier relaunch
      // (starter margin rescue). Existing subscribers are grandfathered: their
      // Stripe commitment schedules were created at the old renewal price and
      // are not rewritten — this constant only prices NEW checkouts/schedules.
      biennial: { monthlyCents: 999, renewalMonthlyCents: 1999 },
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

/** Commitment end date: now + N months, preserving day-of-month (clamped). */
export function renewalDateAfterMonths(now: Date, commitmentMonths: number): Date {
  const originalDay = now.getDate();
  const renewalAt = new Date(now);
  renewalAt.setDate(1);
  renewalAt.setMonth(renewalAt.getMonth() + commitmentMonths);
  const daysInTargetMonth = new Date(renewalAt.getFullYear(), renewalAt.getMonth() + 1, 0).getDate();
  renewalAt.setDate(Math.min(originalDay, daysInTargetMonth));
  return renewalAt;
}

export function isPaidTier(tier: PlanTier): boolean {
  return tier !== "enterprise";
}

export function calculateSavingsPercentage(tier: PlanTier, period: BillingPeriod): number {
  if (period === "monthly") return 0;

  const pricing = PRICING[tier].periods[period];
  const monthlyPricing = PRICING[tier].periods.monthly;
  if (monthlyPricing.renewalMonthlyCents === 0) return 0;

  const savings =
    ((monthlyPricing.renewalMonthlyCents - pricing.monthlyCents) / monthlyPricing.renewalMonthlyCents) * 100;
  return Math.round(savings);
}
