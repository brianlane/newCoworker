/**
 * Per-business margin engine, the tier-economics canvas methodology
 * (PRDs/tier-economics-jul-2026.md) as live code.
 *
 * Revenue is the renewal-aware day-current rate the MRR card uses
 * ({@link dayCurrentSubscriptionRateCents}), less any operator-applied
 * membership discount, plus recurring pack add-ons, priced exactly as
 * computeDayCurrentMrr prices them so the two never
 * disagree, or the active enterprise deal's real monthly price. Costs itemize hosting, DID rental, Telnyx
 * usage, Gemini (metered spend actuals, `owner_chat_model_spend` is the
 * single pool for ALL per-tenant Gemini usage, including Gemini Live audio
 * settled at call teardown, so there is deliberately NO separate
 * rate-estimated voice line: adding one would double-count), and Stripe
 * fees, each line flagged by how much it can be trusted (see
 * {@link MarginLineSource}).
 *
 * Pure computation: callers assemble {@link BusinessMarginInput} (see
 * src/lib/admin/margin-data.ts for the production loader). Nothing bills
 * from these numbers, operator-facing health metrics only.
 */

import { getCommitmentMonths } from "@/lib/plans/tier";
import type { BillingPeriod } from "@/lib/plans/tier";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE
} from "@/lib/plans/enterprise-pricing";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { dayCurrentSubscriptionRateCents, type MrrSubscriptionInput } from "@/lib/admin/mrr";
import { applyMembershipDiscountToCents } from "@/lib/billing/membership-discount";
import {
  listMembershipPackAddonOptions,
  monthlyPackAddonCents,
  type MembershipPackAddonOption
} from "@/lib/billing/membership-pack-addons";
import {
  DOMESTIC_STRIPE_FEE_RATE,
  deriveStripeFeeRate,
  stripeFeeRateForCountry,
  type ObservedStripeFees,
  type StripeFeeRate
} from "@/lib/plans/stripe-fees";
import type { BusinessCountry } from "@/lib/plans/business-country";

export type MarginLineKey =
  | "hosting"
  | "did"
  | "telnyx_usage"
  | "gemini_chat"
  | "stripe_fees";

/**
 * How much a cost line is worth trusting:
 *
 *  - `actual`:      a synced vendor number or our own metering.
 *  - `calibrated`:  our model, but with its rate derived from synced vendor
 *    actuals (the Stripe fee line: a real observed fee rate applied to the
 *    amortized monthly charge, so the line reflects what Stripe really takes
 *    without inheriting the lumpiness of a term plan's one big charge).
 *  - `estimate`:    per-unit rates from src/lib/plans/enterprise-pricing.ts.
 */
export type MarginLineSource = "actual" | "calibrated" | "estimate";

export type MarginLine = {
  key: MarginLineKey;
  label: string;
  cents: number;
  source: MarginLineSource;
};

export type RevenueSource = "subscription" | "enterprise_deal" | "none";

export type BusinessMarginEconomics = {
  businessId: string;
  revenueCents: number;
  revenueSource: RevenueSource;
  lines: MarginLine[];
  costCents: number;
  marginCents: number;
};

export type BusinessMarginInput = {
  businessId: string;
  tier: "starter" | "standard" | "enterprise";
  status: string;
  hostingerVpsId: string | null;
  vpsSize: string | null;
  vpsProvider: string | null;
  /** Newest subscription row (MRR-compatible fields); null when none exists. */
  subscription: (MrrSubscriptionInput & { tier: "starter" | "standard" | "enterprise" }) | null;
  /** Active enterprise deal's monthly price; null when none. */
  enterpriseDealMonthlyCents: number | null;
  /** Synced Hostinger effective-monthly price for this tenant's box; null → estimate. */
  hostingerMonthlyPriceCents: number | null;
  /** This month's synced Telnyx cost (micro-USD, fees included); null → estimate. */
  telnyxMonthCostMicros: number | null;
  /**
   * Distinct Telnyx DIDs this tenant rents. Null when the DID list could not
   * be read, which falls back to the old "one DID per live box" heuristic
   * rather than zeroing the fleet's whole number-rental line.
   */
  didCount: number | null;
  /** This calendar month's metered usage. */
  monthSmsSent: number;
  monthVoiceMinutes: number;
  /** Current-period Gemini chat spend from owner_chat_model_spend (micro-USD). */
  aiSpendMicros: number;
  /**
   * Tenant's resolved country, the fallback signal for the Stripe fee rate
   * when no real charges have been observed. Defaults to "US".
   */
  country?: BusinessCountry;
  /**
   * This tenant's synced Stripe charge totals, used to DERIVE their real
   * effective fee rate; null when the fee sync has nothing for them.
   */
  stripeObservedFees?: ObservedStripeFees | null;
  /**
   * Pack catalog for pricing recurring add-ons, same contract as
   * computeDayCurrentMrr: defaults to the env-gated live catalog, tests
   * inject fixtures, and an unknown pack id prices as 0.
   */
  packAddonOptions?: MembershipPackAddonOption[];
};

/**
 * Stripe's effective monthly fee for a plan billed every `commitmentMonths`
 * months: term plans charge the whole term in one transaction, so the $0.30
 * fixed fee is spread across the term (the canvas's
 * `stripeMonthlyForBiennial` math generalized).
 *
 * `rate` defaults to the US-card headline rate. Pass the tenant's resolved
 * rate (see src/lib/plans/stripe-fees.ts) so an international card or an
 * observed effective rate is priced correctly.
 */
export function stripeMonthlyFeeCents(
  monthlyRateCents: number,
  commitmentMonths: number,
  rate: StripeFeeRate = DOMESTIC_STRIPE_FEE_RATE
): number {
  const months = commitmentMonths >= 1 ? commitmentMonths : 1;
  const chargeCents = monthlyRateCents * months;
  const feeCents = chargeCents * rate.percent + rate.fixedCents;
  return feeCents / months;
}

export function computeBusinessMargin(
  input: BusinessMarginInput,
  now: Date = new Date()
): BusinessMarginEconomics {
  // ---- Revenue: enterprise deal price wins; else the day-current
  // subscription rate (active + Stripe-backed only, same gate as MRR). ----
  let revenueCents = 0;
  let revenueSource: RevenueSource = "none";
  let stripeCommitmentMonths = 1;
  if (input.enterpriseDealMonthlyCents !== null) {
    revenueCents = input.enterpriseDealMonthlyCents;
    revenueSource = "enterprise_deal";
  } else if (
    input.subscription !== null &&
    input.subscription.status === "active" &&
    input.subscription.stripe_subscription_id !== null &&
    input.subscription.tier !== "enterprise"
  ) {
    // Plan rate PLUS recurring pack add-ons, exactly as computeDayCurrentMrr
    // counts them. Packs bill every cycle, so they are revenue; leaving them
    // out here made per-tenant margin understate a pack-carrying tenant AND
    // made the fleet revenue base disagree with the MRR card the admin
    // Dashboard subtracts cost from.
    const period: BillingPeriod = input.subscription.billing_period ?? "monthly";
    revenueCents =
      // An operator-applied membership discount comes off the plan line and
      // nothing else, exactly as computeDayCurrentMrr takes it off. Without
      // this the two numbers disagree the moment anyone is comped, and the
      // disagreement runs the wrong way: margin would report full revenue on
      // the very tenants whose revenue was cut, hiding a comp that had gone
      // margin-negative. The Stripe fee line below derives from revenueCents,
      // so it follows down on its own, which is also correct: Stripe charges
      // a percentage of what is actually collected.
      applyMembershipDiscountToCents(
        dayCurrentSubscriptionRateCents(
          input.subscription as MrrSubscriptionInput & { tier: "starter" | "standard" },
          now
        ),
        input.subscription,
        now
      ) +
      monthlyPackAddonCents(
        input.subscription.membership_pack_addons ?? null,
        period,
        input.packAddonOptions ?? listMembershipPackAddonOptions()
      );
    revenueSource = "subscription";
    stripeCommitmentMonths = getCommitmentMonths(period);
  }

  const lines: MarginLine[] = [];

  // ---- Hosting: only boxes the fleet still runs; BYOS boxes cost no
  // hosting. DID rental is separate and follows the NUMBERS, not the boxes,
  // because Telnyx bills per number. There is no second cost path to keep
  // in step any more: every admin surface composes this engine through
  // src/lib/admin/fleet-cost.ts. ----
  const hasLiveBox = input.status !== "wiped" && input.hostingerVpsId !== null;
  if (hasLiveBox && input.vpsProvider !== "byos") {
    if (input.hostingerMonthlyPriceCents !== null) {
      lines.push({
        key: "hosting",
        label: "Hosting (Hostinger, synced billing)",
        cents: input.hostingerMonthlyPriceCents,
        source: "actual"
      });
    } else {
      lines.push({
        key: "hosting",
        label: "Hosting (Hostinger monthly SKU)",
        cents: HOSTING_MONTHLY_CENTS_BY_SIZE[resolveDeployedVpsSize(input.tier, input.vpsSize)],
        source: "estimate"
      });
    }
  }
  // Telnyx bills per NUMBER, not per box. Counting one DID per live box
  // dropped every number a tenant rents without one: Truly Insurance's
  // Canadian DID (+1 519 800 6401) cost $1.10/mo that no cost line carried,
  // found reconciling the July 2026 invoice. A wiped tenant still drops its
  // DID: teardown releases the number, and a settings row that outlives it
  // must not keep charging a dead tenant. Fall back to the box heuristic
  // only when the DID list is unreadable.
  const didCount = input.status === "wiped" ? 0 : (input.didCount ?? (hasLiveBox ? 1 : 0));
  if (didCount > 0) {
    lines.push({
      key: "did",
      label: didCount === 1 ? "Phone number rental" : `Phone number rentals (${didCount})`,
      cents: didCount * ENTERPRISE_UNIT_COSTS.didMonthlyCents,
      source: "estimate"
    });
  }

  // ---- Telnyx usage: synced invoice actuals win; else per-unit rates. ----
  if (input.telnyxMonthCostMicros !== null) {
    lines.push({
      key: "telnyx_usage",
      label: "Telnyx usage (invoice records)",
      cents: input.telnyxMonthCostMicros / 10_000,
      source: "actual"
    });
  } else {
    lines.push({
      key: "telnyx_usage",
      label: "Telnyx usage (est. from metered SMS + voice)",
      cents:
        input.monthSmsSent * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
        input.monthVoiceMinutes * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute,
      source: "estimate"
    });
  }

  // ---- Gemini: one metered-actuals line. `owner_chat_model_spend` already
  // includes Gemini Live audio (the bridge settles exact tokens at call
  // teardown via owner_chat_ai_settle), so a separate rate-estimated voice
  // line would double-count the Live component. ----
  lines.push({
    key: "gemini_chat",
    label: "Gemini (metered spend, incl. Live voice)",
    cents: input.aiSpendMicros / 10_000,
    source: "actual"
  });

  // ---- Stripe fees on whatever we charge (term $0.30 spread over the term).
  // The RATE comes from this tenant's real charges when the fee sync has
  // seen any, that is what catches an international card, which the flat
  // 2.9% understates by roughly half, and falls back to a country-keyed
  // estimate otherwise. The AMOUNT stays amortized either way: billing a
  // term plan's whole fee in its charge month would make monthly margin
  // lurch, which is the same reason the estimate spreads the $0.30. ----
  if (revenueCents > 0) {
    const observed = input.stripeObservedFees ?? null;
    const derivedRate = observed === null ? null : deriveStripeFeeRate(observed);
    const rate = derivedRate ?? stripeFeeRateForCountry(input.country ?? "US");
    lines.push({
      key: "stripe_fees",
      label:
        derivedRate === null
          ? "Stripe fees (est. from card region)"
          : "Stripe fees (observed rate)",
      cents: stripeMonthlyFeeCents(
        revenueCents,
        revenueSource === "subscription" ? stripeCommitmentMonths : 1,
        rate
      ),
      source: derivedRate === null ? "estimate" : "calibrated"
    });
  }

  const rounded = lines.map((line) => ({ ...line, cents: Math.round(line.cents) }));
  const costCents = rounded.reduce((sum, line) => sum + line.cents, 0);
  return {
    businessId: input.businessId,
    revenueCents,
    revenueSource,
    lines: rounded,
    costCents,
    marginCents: revenueCents - costCents
  };
}

export type FleetMarginTotals = {
  revenueCents: number;
  costCents: number;
  marginCents: number;
  /** Margin as % of revenue; null when there is no revenue. */
  marginPct: number | null;
  payingBusinesses: number;
};

export function computeFleetMarginTotals(
  economics: BusinessMarginEconomics[]
): FleetMarginTotals {
  let revenueCents = 0;
  let costCents = 0;
  let payingBusinesses = 0;
  for (const e of economics) {
    revenueCents += e.revenueCents;
    costCents += e.costCents;
    if (e.revenueSource !== "none") payingBusinesses += 1;
  }
  const marginCents = revenueCents - costCents;
  return {
    revenueCents,
    costCents,
    marginCents,
    marginPct: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : null,
    payingBusinesses
  };
}
