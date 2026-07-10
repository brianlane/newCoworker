/**
 * Day-current best-effort MRR + estimated monthly platform cost for the
 * admin dashboard KPI card.
 *
 * REVENUE: unlike the old card math (active rows × the static contract rate
 * in src/lib/plans/tier.ts), this picks the rate a subscription is actually
 * on TODAY: inside a committed (possibly auto-renewed) term → contract rate;
 * rolled onto month-to-month after the term (per `isCommitmentElapsed`, the
 * same signal the billing page and change-plan use) → the higher renewal
 * rate. Rows with no Stripe subscription behind them (internal pilots,
 * admin-created accounts) are excluded — nobody is being charged.
 * Enterprise is priced from its ACTIVE `enterprise_deals` row (the real
 * quoted monthly price) instead of the $0 tier-table placeholder.
 *
 * COST: local estimate from the same cost snapshot the enterprise deal
 * calculator uses (src/lib/plans/enterprise-pricing.ts): the Hostinger
 * monthly SKU for every provisioned box, one Telnyx DID per live tenant,
 * this calendar month's metered SMS/voice usage at per-unit rates, and the
 * Gemini AI spend actuals. BYOS boxes cost the platform no hosting (the
 * customer owns the hardware) but still carry a DID.
 *
 * Known best-effort drift, deliberately not modeled: grandfathered starter
 * renewal prices (pre-Jul-2026 schedules), the monthly intro coupon, and
 * the Canadian messaging surcharge add-on. Nothing bills from these numbers
 * — they are an operator-facing health metric.
 */

import { getCommitmentMonths, getPeriodPricing } from "@/lib/plans/tier";
import type { BillingPeriod } from "@/lib/plans/tier";
import { isCommitmentElapsed } from "@/lib/db/subscriptions";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  VOICE_ALL_IN_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { addUtcMonthsClamped } from "../../../supabase/functions/_shared/billing_period_window";

/** The subscription fields the revenue calculation reads (SubscriptionRow-compatible). */
export type MrrSubscriptionInput = {
  tier: "starter" | "standard" | "enterprise";
  status: string;
  stripe_subscription_id: string | null;
  billing_period: BillingPeriod | null;
  renewal_at: string | null;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  created_at: string;
};

export type DayCurrentMrr = {
  totalCents: number;
  /** Starter/standard portion (tier-table rates, renewal-aware). */
  subscriptionCents: number;
  /** Enterprise portion (active deals' real monthly prices). */
  enterpriseDealCents: number;
  /** Subscriptions that actually counted (active + Stripe-backed, non-enterprise). */
  countedSubscriptions: number;
};

/**
 * The monthly rate a starter/standard subscription is on as of `now`.
 *
 * Term (12/24-month) plans use the codebase's canonical rollover signal,
 * {@link isCommitmentElapsed}: a past `renewal_at` alone is NOT enough,
 * because with auto-renew ON the subscription renews for another FULL
 * prepaid term while `renewal_at` is never advanced — the cached Stripe
 * period being monthly-length is what distinguishes "rolling month-to-month
 * at the renewal rate" from "inside a (possibly renewed) contract at the
 * contract rate". Missing period cache fails toward "still committed"
 * (the LOWER contract rate), same direction the billing page fails.
 *
 * Monthly plans have no commitment: the intro month bills the contract rate,
 * everything after it the ongoing renewal rate. The intro-month end prefers
 * `renewal_at` (stamped at checkout as start + 1 month) and falls back to
 * `created_at` plus one CLAMPED month (`addUtcMonthsClamped` — the same
 * day-clamping checkout's renewal-date math uses, so a Jan 31 signup ends
 * its intro month on Feb 28, not rolled into March).
 */
function dayCurrentRateCents(
  sub: MrrSubscriptionInput & { tier: "starter" | "standard" },
  now: Date
): number {
  const period: BillingPeriod = sub.billing_period ?? "monthly";
  const pricing = getPeriodPricing(sub.tier, period);

  if (period !== "monthly") {
    return isCommitmentElapsed(sub, now) ? pricing.renewalMonthlyCents : pricing.monthlyCents;
  }

  let introEndMs = sub.renewal_at ? Date.parse(sub.renewal_at) : Number.NaN;
  if (!Number.isFinite(introEndMs)) {
    introEndMs = addUtcMonthsClamped(
      new Date(sub.created_at),
      getCommitmentMonths(period)
    ).getTime();
  }
  return now.getTime() < introEndMs ? pricing.monthlyCents : pricing.renewalMonthlyCents;
}

export function computeDayCurrentMrr(params: {
  subscriptions: MrrSubscriptionInput[];
  /** ACTIVE enterprise deals only (see listActiveEnterpriseDeals). */
  enterpriseDeals: Array<{ monthly_cents: number }>;
  now?: Date;
}): DayCurrentMrr {
  const now = params.now ?? new Date();

  let subscriptionCents = 0;
  let countedSubscriptions = 0;
  for (const sub of params.subscriptions) {
    // Only money that actually recurs: an "active" flag with no Stripe
    // subscription behind it charges nobody. Enterprise revenue comes from
    // its deal row, not the $0 tier table.
    if (sub.status !== "active" || sub.stripe_subscription_id === null) continue;
    if (sub.tier === "enterprise") continue;
    subscriptionCents += dayCurrentRateCents(
      sub as MrrSubscriptionInput & { tier: "starter" | "standard" },
      now
    );
    countedSubscriptions += 1;
  }

  const enterpriseDealCents = params.enterpriseDeals.reduce(
    (sum, deal) => sum + deal.monthly_cents,
    0
  );

  return {
    totalCents: subscriptionCents + enterpriseDealCents,
    subscriptionCents,
    enterpriseDealCents,
    countedSubscriptions
  };
}

/** The business fields the cost estimate reads (BusinessRow-compatible). */
export type PlatformCostBusinessInput = {
  tier: "starter" | "standard" | "enterprise";
  status: string;
  hostinger_vps_id: string | null;
  vps_size?: string | null;
  vps_provider?: string | null;
};

export type MonthlyPlatformCostEstimate = {
  /** Hostinger monthly SKU across provisioned, platform-paid boxes. */
  hostingCents: number;
  /** Telnyx DID rental across live tenants. */
  didCents: number;
  /** This calendar month's metered SMS + voice at per-unit rates. */
  usageCents: number;
  /** Gemini AI spend actuals (current period rows), micro-USD → cents. */
  aiSpendCents: number;
  totalCents: number;
  /** Provisioned boxes counted (including BYOS, which add no hosting cost). */
  boxCount: number;
};

export function estimateMonthlyPlatformCost(params: {
  businesses: PlatformCostBusinessInput[];
  monthUsage: { smsSent: number; voiceMinutes: number };
  aiSpendMicros: number;
}): MonthlyPlatformCostEstimate {
  let hostingCents = 0;
  let didCents = 0;
  let boxCount = 0;
  for (const business of params.businesses) {
    // Only boxes the fleet still runs: wiped tenants' VMs are released or
    // parked in the pool (auto-renew off = sunk cost, not recurring spend).
    if (business.status === "wiped" || !business.hostinger_vps_id) continue;
    boxCount += 1;
    didCents += ENTERPRISE_UNIT_COSTS.didMonthlyCents;
    if (business.vps_provider === "byos") continue;
    hostingCents +=
      HOSTING_MONTHLY_CENTS_BY_SIZE[resolveDeployedVpsSize(business.tier, business.vps_size)];
  }

  const usageCents = Math.round(
    params.monthUsage.smsSent * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
      params.monthUsage.voiceMinutes * VOICE_ALL_IN_CENTS_PER_MINUTE
  );
  // 1 cent = 10,000 micro-USD.
  const aiSpendCents = Math.round(params.aiSpendMicros / 10_000);

  return {
    hostingCents,
    didCents,
    usageCents,
    aiSpendCents,
    totalCents: hostingCents + didCents + usageCents + aiSpendCents,
    boxCount
  };
}
