import { getPeriodPricing, PlanTier, BillingPeriod, getCommitmentMonths } from "./plans/tier";

const PRICE_LOCALE = "en-US";

/**
 * Formats price in cents to USD string (e.g., 999 -> "$9.99")
 * Omits .00 suffix when cents are zero (e.g., "$195" not "$195.00")
 */
export function formatPriceCents(cents: number): string {
  const dollars = cents / 100;
  const integerPart = Math.floor(dollars);
  const decimalPart = dollars - integerPart;

  if (decimalPart === 0) {
    return `$${integerPart.toLocaleString(PRICE_LOCALE)}`;
  }

  // Add thousands separator and format cents
  const [integer, decimal] = dollars.toFixed(2).split(".");
  return `$${parseInt(integer, 10).toLocaleString(PRICE_LOCALE)}.${decimal}`;
}

/**
 * Formats price per month for display (e.g., "$9.99/mo")
 */
export function formatPricePerMonth(cents: number): string {
  return `$${(cents / 100).toFixed(2)}/mo`;
}

/**
 * Calculates total commitment price for a billing period
 */
export function calculateCommitmentTotal(tier: PlanTier, period: BillingPeriod): number {
  const pricing = getPeriodPricing(tier, period);
  const months = getCommitmentMonths(period);
  return pricing.monthlyCents * months;
}

/**
 * Formats the commitment total for display
 */
export function formatCommitmentTotal(tier: PlanTier, period: BillingPeriod): string {
  const total = calculateCommitmentTotal(tier, period);
  return formatPriceCents(total);
}

/**
 * Gets the monthly rate string for a tier and period
 */
export function getMonthlyRateDisplay(tier: PlanTier, period: BillingPeriod): string {
  const pricing = getPeriodPricing(tier, period);
  return formatPricePerMonth(pricing.monthlyCents);
}

/**
 * Gets the renewal rate string for a tier and period
 */
export function getRenewalRateDisplay(tier: PlanTier, period: BillingPeriod): string {
  const pricing = getPeriodPricing(tier, period);
  return formatPricePerMonth(pricing.renewalMonthlyCents);
}

/**
 * Returns the amount discounted from the first billing cycle.
 * Only the monthly plan uses an intro price today.
 */
export function getFirstCycleDiscountCents(tier: PlanTier, period: BillingPeriod): number {
  if (period !== "monthly") return 0;

  const pricing = getPeriodPricing(tier, period);
  return Math.max(pricing.renewalMonthlyCents - pricing.monthlyCents, 0);
}

export function hasFirstCycleDiscount(tier: PlanTier, period: BillingPeriod): boolean {
  return getFirstCycleDiscountCents(tier, period) > 0;
}

export function getFirstCycleDiscountDisplay(tier: PlanTier, period: BillingPeriod): string {
  return formatPriceCents(getFirstCycleDiscountCents(tier, period));
}
