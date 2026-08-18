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
  MEXICO_MESSAGING_FEE_MONTHLY_CENTS,
  MEXICO_MESSAGING_FEE_NAME
} from "@/lib/plans/mexican-messaging";
import type { BusinessCountry } from "@/lib/plans/business-country";
import {
  formatCommitmentTotal,
  formatPriceCents,
  getFirstCycleDiscountDisplay,
  getMonthlyRateDisplay,
  getPlanDueTodayCents,
  getPlanListPriceCents,
  getRenewalRateDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";
import {
  MembershipPackAddOns,
  membershipPackAddOnsDueTodayCents
} from "@/components/billing/MembershipPackAddOns";
import type {
  MembershipPackAddonOption,
  MembershipPackAddonSelection
} from "@/lib/billing/membership-pack-addons";

type OrderSummaryCardProps = {
  tier: PlanTier;
  period: BillingPeriod;
  businessName?: string;
  preferFirstMonthLabel?: boolean;
  /**
   * Signup country: drives the labeled monthly messaging surcharge line (CA
   * or MX, folded into "due today" at the plan's cadence, × term months on
   * prepaid plans) and, for MX, hides the US carrier-registration fee that
   * /api/checkout skips. ONE prop instead of per-country booleans so the
   * preview can never show two fees or a fee/carrier combination the
   * checkout would not charge. Must mirror the server: pass
   * resolveBusinessCountry() over the same phone/timezone the draft holds.
   */
  country?: BusinessCountry;
  /**
   * Applied promo code, as returned by /api/promotions/validate. Stripe allows
   * one discount per Checkout Session, so an applied promo REPLACES the
   * first-cycle intro coupon, the same precedence /api/checkout uses, which
   * is why the intro-discount line disappears while one is applied.
   *
   * The duration fields drive the continuation note on monthly plans. A
   * repeating/forever code can be the better deal over its span while its
   * first invoice sits ABOVE the intro price it displaced; without saying the
   * discount continues, that reads as "I entered a code and the price went
   * up". Optional so existing callers (and stale state) degrade to the
   * one-invoice presentation.
   */
  promotion?: {
    code: string;
    discountCents: number;
    duration?: "once" | "repeating" | "forever";
    durationInMonths?: number | null;
  } | null;
  /** Env-gated usage-pack catalog for optional membership add-ons. */
  packAddonOptions?: MembershipPackAddonOption[];
  packAddonSelection?: MembershipPackAddonSelection;
  onPackAddonChange?: (next: MembershipPackAddonSelection) => void;
};

export function OrderSummaryCard({
  tier,
  period,
  businessName,
  preferFirstMonthLabel = false,
  country = "US",
  promotion = null,
  packAddonOptions = [],
  packAddonSelection = {},
  onPackAddonChange
}: OrderSummaryCardProps) {
  const t = useTranslations("marketing.orderSummary");
  const hasIntroDiscount = hasFirstCycleDiscount(tier, period) && promotion === null;
  const firstCyclePrice = getMonthlyRateDisplay(tier, period);
  const renewalPrice = getRenewalRateDisplay(tier, period);
  const firstCycleDiscount = getFirstCycleDiscountDisplay(tier, period);
  // 12/24-month plans are charged IN FULL at checkout (the VPS for the whole
  // term is prepaid), so "due today" is the commitment total and the monthly
  // figure is only the effective rate. Monthly plans keep first-cycle pricing.
  // Every new signup additionally pays the one-time 10DLC carrier
  // registration fee (non-refundable pass-through, Phase C3) on the first
  // invoice, so it is part of "due today".
  // A promo code replaces the intro coupon, so its discount comes off the
  // plan's LIST price (on monthly, that is the full renewal rate the Stripe
  // price carries, not the already-discounted intro figure).
  const isTermPlan = period !== "monthly";
  const canadianFee = country === "CA";
  const mexicanFee = country === "MX";
  // Mexican signups skip the US 10DLC carrier fee (their +52 traffic cannot
  // use a US carrier registration; /api/checkout charges 0).
  const carrierFeeCents = mexicanFee ? 0 : CARRIER_REGISTRATION_FEE_CENTS;
  // Clamped to the plan line: the discount is priced for one plan, so a value
  // left over from a plan switch must never drive the total negative or eat
  // into the carrier fee.
  const promoDiscountCents =
    promotion === null
      ? 0
      : Math.min(Math.max(promotion.discountCents, 0), getPlanListPriceCents(tier, period));
  const planDueTodayCents =
    promotion === null
      ? getPlanDueTodayCents(tier, period)
      : getPlanListPriceCents(tier, period) - promoDiscountCents;
  // Canadian signups: $4.99/mo surcharge billed at the plan's cadence, so a
  // term plan pays it upfront for the whole term (like the plan itself).
  const canadaFeeDueTodayCents = canadianFee
    ? CANADA_MESSAGING_FEE_MONTHLY_CENTS * getCommitmentMonths(period)
    : 0;
  // Mexican signups: $9.99/mo surcharge, same cadence rule as the Canadian one.
  const mexicoFeeDueTodayCents = mexicanFee
    ? MEXICO_MESSAGING_FEE_MONTHLY_CENTS * getCommitmentMonths(period)
    : 0;
  const packAddOnsDueTodayCents = membershipPackAddOnsDueTodayCents(
    packAddonSelection,
    packAddonOptions,
    period
  );
  const totalDueToday = formatPriceCents(
    planDueTodayCents +
      carrierFeeCents +
      canadaFeeDueTodayCents +
      mexicoFeeDueTodayCents +
      packAddOnsDueTodayCents
  );
  // With a promo applied to a monthly plan the intro coupon is gone, so the
  // rate row shows the plan's real rate and the promo line carries the saving.
  const rateDisplay = !isTermPlan && promotion !== null ? renewalPrice : firstCyclePrice;
  // Continuation note: only meaningful on monthly plans (a term plan is one
  // prepaid invoice, and what happens after the term is priced by the
  // commitment schedule, not this code).
  const promoContinues =
    !isTermPlan && promotion !== null && promotion.duration != null && promotion.duration !== "once"
      ? promotion.duration
      : null;
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
          <span>{rateDisplay}</span>
        </span>
      </div>
      {hasIntroDiscount && (
        <div className="flex justify-between text-spark-orange text-xs">
          <span>{t("introDiscount")}</span>
          <span>-{firstCycleDiscount}</span>
        </div>
      )}
      {promotion !== null && (
        <div className="flex justify-between text-claw-green text-xs">
          <span>{t("promoDiscount", { code: promotion.code })}</span>
          <span>-{formatPriceCents(promoDiscountCents)}</span>
        </div>
      )}
      {promoContinues !== null && promotion !== null && (
        <p className="text-xs text-claw-green/80">
          {promoContinues === "forever"
            ? t("promoOngoingForever", {
                code: promotion.code,
                amount: formatPriceCents(promoDiscountCents)
              })
            : t("promoOngoingMonths", {
                code: promotion.code,
                amount: formatPriceCents(promoDiscountCents),
                months: promotion.durationInMonths ?? 1
              })}
        </p>
      )}
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>{t("renewalAfter", { plan: planLabel })}</span>
        <span>{renewalPrice}</span>
      </div>
      <div className="flex justify-between text-parchment/40 text-xs">
        <span>{t("commitmentTotal")}</span>
        <span>{formatCommitmentTotal(tier, period)}</span>
      </div>
      {!mexicanFee && (
        <div className="flex justify-between text-parchment/70">
          <span>{t("carrierRegistration")}</span>
          <span>{formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS)}</span>
        </div>
      )}
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
      {mexicanFee && (
        <div className="flex justify-between text-parchment/70">
          <span>
            {t("mexicoFeeLine", {
              name: MEXICO_MESSAGING_FEE_NAME,
              monthly: formatPriceCents(MEXICO_MESSAGING_FEE_MONTHLY_CENTS),
              termSuffix: isTermPlan
                ? t("mexicoFeeTermSuffix", { months: getCommitmentMonths(period) })
                : ""
            })}
          </span>
          <span>{formatPriceCents(mexicoFeeDueTodayCents)}</span>
        </div>
      )}
      {onPackAddonChange && packAddonOptions.length > 0 && (
        <div className="pt-2">
          <MembershipPackAddOns
            period={period}
            options={packAddonOptions}
            selection={packAddonSelection}
            onChange={onPackAddonChange}
          />
        </div>
      )}
      {packAddOnsDueTodayCents > 0 && (
        <div className="flex justify-between text-parchment/70">
          <span>{t("packAddOnsLine")}</span>
          <span>{formatPriceCents(packAddOnsDueTodayCents)}</span>
        </div>
      )}
      <div className="flex justify-between text-parchment font-semibold pt-1 border-t border-parchment/10">
        <span>{t("totalDueToday")}</span>
        <span>{totalDueToday}</span>
      </div>
      {!mexicanFee && <p className="text-xs text-parchment/45">{t("carrierFeeNote")}</p>}
      {canadianFee && (
        <p className="text-xs text-parchment/45">
          {t("canadaFeeNote", { name: CANADA_MESSAGING_FEE_NAME.toLowerCase() })}
        </p>
      )}
      {mexicanFee && (
        <p className="text-xs text-parchment/45">
          {t("mexicoFeeNote", { name: MEXICO_MESSAGING_FEE_NAME.toLowerCase() })}
        </p>
      )}
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          {t("termBilledNote", { period: periodLabel, renewalPrice })}
        </p>
      )}
      {isTermPlan && (
        <p className="text-xs text-parchment/45">
          {/* The refund carve-out matches invoice LINES by the carrier-fee
              name, so a signup that was never charged the fee has nothing
              to deduct. Saying otherwise would promise a smaller refund
              than they actually get. */}
          {/* No monthly-rate interpolation any more: the term deduction was
              removed in Aug 2026 along with the term box it recovered. */}
          {t(mexicanFee ? "guaranteeNoteNoCarrierFee" : "guaranteeNote")}
        </p>
      )}
    </div>
  );
}
