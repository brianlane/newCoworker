/**
 * Per-business margin engine — the tier-economics canvas methodology
 * (PRDs/tier-economics-jul-2026.md) as live code.
 *
 * Revenue is the renewal-aware day-current rate the MRR card uses
 * ({@link dayCurrentSubscriptionRateCents}) or the active enterprise
 * deal's real monthly price. Costs itemize hosting, DID rental, Telnyx
 * usage, Gemini (metered spend actuals — `owner_chat_model_spend` is the
 * single pool for ALL per-tenant Gemini usage, including Gemini Live audio
 * settled at call teardown, so there is deliberately NO separate
 * rate-estimated voice line: adding one would double-count), and Stripe
 * fees, each line flagged `actual` (a synced vendor number or our own
 * metering) or `estimate` (per-unit rates from
 * src/lib/plans/enterprise-pricing.ts).
 *
 * Pure computation: callers assemble {@link BusinessMarginInput} (see
 * src/lib/admin/margin-data.ts for the production loader). Nothing bills
 * from these numbers — operator-facing health metrics only.
 */

import { getCommitmentMonths } from "@/lib/plans/tier";
import type { BillingPeriod } from "@/lib/plans/tier";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE
} from "@/lib/plans/enterprise-pricing";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { dayCurrentSubscriptionRateCents, type MrrSubscriptionInput } from "@/lib/admin/mrr";

export type MarginLineKey =
  | "hosting"
  | "did"
  | "telnyx_usage"
  | "gemini_chat"
  | "stripe_fees";

export type MarginLineSource = "actual" | "estimate";

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
  /** This calendar month's metered usage. */
  monthSmsSent: number;
  monthVoiceMinutes: number;
  /** Current-period Gemini chat spend from owner_chat_model_spend (micro-USD). */
  aiSpendMicros: number;
};

/**
 * Stripe's effective monthly fee for a plan billed every `commitmentMonths`
 * months: term plans charge the whole term in one transaction, so the $0.30
 * fixed fee is spread across the term (the canvas's
 * `stripeMonthlyForBiennial` math generalized).
 */
export function stripeMonthlyFeeCents(monthlyRateCents: number, commitmentMonths: number): number {
  const months = commitmentMonths >= 1 ? commitmentMonths : 1;
  const chargeCents = monthlyRateCents * months;
  const feeCents =
    chargeCents * ENTERPRISE_UNIT_COSTS.stripePercent +
    ENTERPRISE_UNIT_COSTS.stripeFixedCentsPerCharge;
  return feeCents / months;
}

export function computeBusinessMargin(
  input: BusinessMarginInput,
  now: Date = new Date()
): BusinessMarginEconomics {
  // ---- Revenue: enterprise deal price wins; else the day-current
  // subscription rate (active + Stripe-backed only — same gate as MRR). ----
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
    revenueCents = dayCurrentSubscriptionRateCents(
      input.subscription as MrrSubscriptionInput & { tier: "starter" | "standard" },
      now
    );
    revenueSource = "subscription";
    const period: BillingPeriod = input.subscription.billing_period ?? "monthly";
    stripeCommitmentMonths = getCommitmentMonths(period);
  }

  const lines: MarginLine[] = [];

  // ---- Hosting + DID: only boxes the fleet still runs (mirrors
  // estimateMonthlyPlatformCost); BYOS boxes cost no hosting but carry a DID. ----
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
  if (hasLiveBox) {
    lines.push({
      key: "did",
      label: "Phone number rental",
      cents: ENTERPRISE_UNIT_COSTS.didMonthlyCents,
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

  // ---- Stripe fees on whatever we charge (term $0.30 spread over the term). ----
  if (revenueCents > 0) {
    lines.push({
      key: "stripe_fees",
      label: "Stripe fees",
      cents: stripeMonthlyFeeCents(
        revenueCents,
        revenueSource === "subscription" ? stripeCommitmentMonths : 1
      ),
      source: "estimate"
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
