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
 * this calendar month's metered SMS/voice usage at TELNYX-ONLY per-unit
 * rates, and the Gemini spend actuals (which already include Gemini Live
 * voice, settled into `owner_chat_model_spend` at call teardown — pricing
 * voice all-in here would double-count it). BYOS boxes cost the platform
 * no hosting (the customer owns the hardware) but still carry a DID.
 *
 * Known best-effort drift, deliberately not modeled: grandfathered starter
 * renewal prices (pre-Jul-2026 schedules), the monthly intro coupon, and
 * the Canadian and Mexican messaging surcharge add-ons. Nothing bills from
 * these numbers — they are an operator-facing health metric.
 */

import { getCommitmentMonths, getPeriodPricing } from "@/lib/plans/tier";
import type { BillingPeriod } from "@/lib/plans/tier";
import { isCommitmentElapsed } from "@/lib/db/subscriptions";
import {
  ENTERPRISE_UNIT_COSTS,
  HOSTING_MONTHLY_CENTS_BY_SIZE,
  TELNYX_CAMPAIGN_FEE_MONTHLY_CENTS,
  TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { addUtcMonthsClamped } from "../../../supabase/functions/_shared/billing_period_window";
import {
  listMembershipPackAddonOptions,
  monthlyPackAddonCents,
  type MembershipPackAddonOption
} from "@/lib/billing/membership-pack-addons";

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
  /**
   * True when the owner's 30-day money-back window is still open and unused
   * AND the placement is self-serve refundable — this subscription's revenue
   * could still be clawed back in full. Stamped by the admin-page loader
   * (`stampRefundExposure` in src/lib/admin/mrr-exposure.ts); omitted/false →
   * counted as committed revenue.
   */
  refund_exposed?: boolean;
  /**
   * Read cache of the Stripe subscription's recurring pack add-ons
   * (§20260822034834). Priced into the rate so pack revenue, which bills
   * every cycle since #1026, shows on the tile. `unknown` because it is a
   * jsonb read the pricer validates itself.
   */
  membership_pack_addons?: unknown;
};

export type DayCurrentMrr = {
  totalCents: number;
  /** Starter/standard portion (tier-table rates, renewal-aware). */
  subscriptionCents: number;
  /** Enterprise portion (active deals' real monthly prices). */
  enterpriseDealCents: number;
  /** Subscriptions that actually counted (active + Stripe-backed, non-enterprise). */
  countedSubscriptions: number;
  /**
   * Portion of `totalCents` from refund-exposed subscriptions (owner still
   * inside the unused 30-day money-back window — they can refund instead of
   * merely not renewing). Enterprise deals never count here.
   */
  refundExposedCents: number;
  /** `totalCents` minus `refundExposedCents` — MRR excluding first-month refund risk. */
  committedCents: number;
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
export function dayCurrentSubscriptionRateCents(
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
  /**
   * Pack catalog for pricing mirrored add-ons. Defaults to the env-gated
   * live catalog; tests inject fixtures. A pack id missing from the catalog
   * prices as 0 (degrade the number, never the page).
   */
  packAddonOptions?: MembershipPackAddonOption[];
  now?: Date;
}): DayCurrentMrr {
  const now = params.now ?? new Date();
  const packAddonOptions = params.packAddonOptions ?? listMembershipPackAddonOptions();

  let subscriptionCents = 0;
  let countedSubscriptions = 0;
  let refundExposedCents = 0;
  for (const sub of params.subscriptions) {
    // Only money that actually recurs: an "active" flag with no Stripe
    // subscription behind it charges nobody. Enterprise revenue comes from
    // its deal row, not the $0 tier table.
    if (sub.status !== "active" || sub.stripe_subscription_id === null) continue;
    if (sub.tier === "enterprise") continue;
    // Plan rate plus the recurring packs the subscription carries: both bill
    // every cycle, but only the plan rate is refund-exposed. Membership pack
    // dollars are non-refundable (the refund executor carves pack lines out
    // of the money-back, Aug 2026), so counting them in refundExposedCents
    // would overstate the at-risk number the admin cards display.
    const planRateCents = dayCurrentSubscriptionRateCents(
      sub as MrrSubscriptionInput & { tier: "starter" | "standard" },
      now
    );
    const packCents = monthlyPackAddonCents(
      sub.membership_pack_addons ?? null,
      sub.billing_period ?? "monthly",
      packAddonOptions
    );
    subscriptionCents += planRateCents + packCents;
    if (sub.refund_exposed === true) refundExposedCents += planRateCents;
    countedSubscriptions += 1;
  }

  const enterpriseDealCents = params.enterpriseDeals.reduce(
    (sum, deal) => sum + deal.monthly_cents,
    0
  );

  const totalCents = subscriptionCents + enterpriseDealCents;
  return {
    totalCents,
    subscriptionCents,
    enterpriseDealCents,
    countedSubscriptions,
    refundExposedCents,
    committedCents: totalCents - refundExposedCents
  };
}
