import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import {
  formatCommitmentTotal,
  getFirstCycleDiscountDisplay,
  getMonthlyRateDisplay,
  getRenewalRateDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";

type OrderSummaryCardProps = {
  tier: PlanTier;
  period: BillingPeriod;
  businessName?: string;
  assistantBriefPercent?: number;
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
  assistantBriefPercent,
  preferFirstMonthLabel = false
}: OrderSummaryCardProps) {
  const hasIntroDiscount = hasFirstCycleDiscount(tier, period);
  const firstCyclePrice = getMonthlyRateDisplay(tier, period);
  const renewalPrice = getRenewalRateDisplay(tier, period);
  const firstCycleDiscount = getFirstCycleDiscountDisplay(tier, period);
  const monthlyLabel = preferFirstMonthLabel && hasIntroDiscount ? "First month" : "Monthly rate";

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
        <span>{businessName?.trim() ? businessName : "—"}</span>
      </div>
      {typeof assistantBriefPercent === "number" && (
        <div className="flex justify-between text-parchment/70">
          <span>Assistant brief</span>
          <span>{assistantBriefPercent}% captured</span>
        </div>
      )}
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
        <span>Total due today</span>
        <span>{firstCyclePrice}</span>
      </div>
      <div className="flex justify-between text-parchment/40 text-xs pt-1 border-t border-parchment/10">
        <span>Commitment total</span>
        <span>{formatCommitmentTotal(tier, period)}</span>
      </div>
    </div>
  );
}
