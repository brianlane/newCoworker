import { useTranslations } from "next-intl";
import {
  getCommitmentMonths,
  getPeriodPricing,
  type BillingPeriod,
  type PlanTier
} from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import {
  CANADA_MESSAGING_FEE_MONTHLY_CENTS,
  CANADA_MESSAGING_FEE_NAME
} from "@/lib/plans/canadian-messaging";
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
  /**
   * Canadian signup: shows the labeled monthly messaging surcharge line and
   * folds it into "due today" (billed at the plan's cadence — × term months
   * on prepaid plans). Must mirror what /api/checkout actually charges, so
   * pass isCanadianBusiness() over the same phone/timezone the draft holds.
   */
  canadianFee?: boolean;
};

export function OrderSummaryCard({
  tier,
  period,
  businessName,
  preferFirstMonthLabel = false,
  canadianFee = false
}: OrderSummaryCardProps) {
  const t = useTranslations("marketing.orderSummary");
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
  // Canadian signups: $4.99/mo surcharge billed at the plan's cadence, so a
  // term plan pays it upfront for the whole term (like the plan itself).
  const canadaFeeDueTodayCents = canadianFee
    ? CANADA_MESSAGING_FEE_MONTHLY_CENTS * getCommitmentMonths(period)
    : 0;
  const totalDueToday = formatPriceCents(
    planDueTodayCents + CARRIER_REGISTRATION_FEE_CENTS + canadaFeeDueTodayCents
  );
  const monthlyLabel = isTermPlan
    ? t("effectiveMonthly")
    : preferFirstMonthLabel && hasIntroDiscount
      ? t("firstMonth")
      : t("monthlyRate");
  const periodLabel =
    period === "biennial" ? t("period24") : period === "annual" ? t("period12") : t("period1");
  const planLabel = `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;

  return (
    <div className="bg-parchment/5 rounded-lg p-4 space-y-2">
      <h3 className="font-semibold text-parchment">{t("title")}</h3>
      <div className="flex justify-between text-parchment/70">
        <span>{t("plan")}</span>
        <span className="capitalize">{tier}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>{t("billingPeriod")}</span>
        <span>{periodLabel}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>{t("business")}</span>
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
          <span>{t("introDiscount")}</span>
          <span>-{firstCycleDiscount}</span>
        </div>
      )}
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>{t("renewalAfter", { plan: planLabel })}</span>
        <span>{renewalPrice}</span>
      </div>
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>{t("commitmentTotal")}</span>
        <span>{formatCommitmentTotal(tier, period)}</span>
      </div>
      <div className="flex justify-between text-parchment/70">
        <span>{t("carrierRegistration")}</span>
        <span>{formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS)}</span>
      </div>
      {canadianFee && (
        <div className="flex justify-between text-parchment/70">
          <span>
            {t("canadaFeeLine", {
              name: CANADA_MESSAGING_FEE_NAME,
              monthly: formatPriceCents(CANADA_MESSAGING_FEE_MONTHLY_CENTS),
              termSuffix: isTermPlan
                ? t("canadaFeeTermSuffix", { months: getCommitmentMonths(period) })
                : ""
            })}
          </span>
          <span>{formatPriceCents(canadaFeeDueTodayCents)}</span>
        </div>
      )}
      <div className="flex justify-between text-parchment font-semibold pt-1 border-t border-parchment/10">
        <span>{t("totalDueToday")}</span>
        <span>{totalDueToday}</span>
      </div>
      <p className="text-xs text-parchment/45">{t("carrierFeeNote")}</p>
      {canadianFee && (
        <p className="text-xs text-parchment/45">
          {t("canadaFeeNote", { name: CANADA_MESSAGING_FEE_NAME.toLowerCase() })}
        </p>
      )}
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          {t("termBilledNote", { period: periodLabel, renewalPrice })}
        </p>
      )}
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          {t("guaranteeNote", {
            monthlyPrice: formatPriceCents(getPeriodPricing(tier, "monthly").monthlyCents)
          })}
        </p>
      )}
    </div>
  );
}
