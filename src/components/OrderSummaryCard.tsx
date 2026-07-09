import { getPeriodPricing, type BillingPeriod, type PlanTier } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import {
  calculateCommitmentTotal,
  formatCommitmentTotal,
  formatPriceCents,
  getFirstCycleDiscountDisplay,
  getMonthlyRateDisplay,
  getRenewalRateDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";

type OrderSummaryCardProps = {
  tier: PlanTier;
  period: BillingPeriod;
  businessName?: string;
  preferFirstMonthLabel?: boolean;
};

function formatPlanLabel(tier: PlanTier): string {
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan`;
}

function formatBillingPeriod(period: BillingPeriod): string {
  if (period === "biennial") return "24 months";
  if (period === "annual") return "12 months";
  return "1 month";
}

export function OrderSummaryCard({
  tier,
  period,
  businessName,
  preferFirstMonthLabel = false
}: OrderSummaryCardProps) {
  const hasIntroDiscount = hasFirstCycleDiscount(tier, period);
  const firstCyclePrice = getMonthlyRateDisplay(tier, period);
  const renewalPrice = getRenewalRateDisplay(tier, period);
  const firstCycleDiscount = getFirstCycleDiscountDisplay(tier, period);
  // 12/24-month plans are charged IN FULL at checkout (the VPS for the whole
  // term is prepaid), so "due today" is the commitment total and the monthly
  // figure is only the effective rate. Monthly plans keep first-cycle pricing.
  // Every new signup additionally pays the one-time 10DLC carrier
  // registration fee (non-refundable pass-through, Phase C3) on the first
  // invoice, so it is part of "due today".
  const isTermPlan = period !== "monthly";
  const planDueTodayCents = isTermPlan
    ? calculateCommitmentTotal(tier, period)
    : getPeriodPricing(tier, period).monthlyCents;
  const totalDueToday = formatPriceCents(planDueTodayCents + CARRIER_REGISTRATION_FEE_CENTS);
  const monthlyLabel = isTermPlan
    ? "Effective monthly rate"
    : preferFirstMonthLabel && hasIntroDiscount
      ? "First month"
      : "Monthly rate";

  return (
    <div className="bg-parchment/5 rounded-lg p-4 space-y-2">
      <h3 className="font-semibold text-parchment">Order Summary</h3>
      <div className="flex justify-between text-parchment/70">
        <span>Plan</span>
        <span className="capitalize">{tier}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>Billing period</span>
        <span>{formatBillingPeriod(period)}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>Business</span>
        <span>{businessName?.trim() ? businessName : "–"}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>{monthlyLabel}</span>
        <span className="flex items-center gap-2">
          {hasIntroDiscount && (
            <span className="text-parchment/35 line-through">{renewalPrice}</span>
          )}
          <span>{firstCyclePrice}</span>
        </span>
      </div>
      {hasIntroDiscount && (
        <div className="flex justify-between text-spark-orange text-xs">
          <span>Intro discount</span>
          <span>-{firstCycleDiscount}</span>
        </div>
      )}
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>Renewal rate after {formatPlanLabel(tier)} ends</span>
        <span>{renewalPrice}</span>
      </div>
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>Commitment total</span>
        <span>{formatCommitmentTotal(tier, period)}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>Carrier registration (10DLC, one-time)</span>
        <span>{formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS)}</span>
      </div>
      <div className="flex justify-between text-parchment font-semibold pt-1 border-t border-parchment/10">
        <span>Total due today</span>
        <span>{totalDueToday}</span>
      </div>
      <p className="text-xs text-parchment/45">
        The carrier registration fee covers your business&apos;s one-time SMS carrier
        (10DLC) registration and is non-refundable.
      </p>
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          The full {formatBillingPeriod(period)} term is billed today. After the term, service
          continues month-to-month at {renewalPrice} unless you renew your contract.
        </p>
      )}
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          30-day money-back guarantee: cancel within 30 days and we refund your term payment
          minus one month of service at the monthly rate (
          {formatPriceCents(getPeriodPricing(tier, "monthly").monthlyCents)}) and the carrier
          registration fee.
        </p>
      )}
    </div>
  );
}
