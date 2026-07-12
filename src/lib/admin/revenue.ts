/**
 * Revenue analytics for /admin/revenue — the BizBlasts Subscription
 * Analytics / Reports pages (month-over-month MRR trend, churn rate, ARPU,
 * top businesses by revenue, failed-payments report) computed from the
 * existing `subscriptions` + `enterprise_deals` rows.
 *
 * All functions are pure and reuse `computeDayCurrentMrr` (src/lib/admin/mrr.ts)
 * as the single pricing source of truth, evaluated at historical month-end
 * anchors for the trend. Historical activity is reconstructed best-effort
 * from `created_at` / `canceled_at` (an `active` row is assumed active since
 * creation) — an operator health metric, not a billing source.
 */

import { computeDayCurrentMrr, type MrrSubscriptionInput } from "@/lib/admin/mrr";

export type RevenueSubscription = MrrSubscriptionInput & {
  business_id: string;
  canceled_at: string | null;
  cancel_reason: string | null;
};

export type RevenueDeal = {
  business_id: string;
  monthly_cents: number;
  status: string;
  activated_at: string | null;
  created_at: string;
};

/**
 * Newest row per business — the same "one subscription per tenant" view the
 * admin dashboard gets from `listSubscriptionsByBusinessIds`. Current-state
 * metrics (MRR, ARPU, top clients, trend anchors, payment problems) must use
 * this so a tenant with historical/overlapping rows can never count twice or
 * resurface a resolved problem; churn alone deliberately keeps the full
 * history (its per-business sets need the canceled rows).
 */
export function dedupeNewestPerBusiness(
  subscriptions: RevenueSubscription[]
): RevenueSubscription[] {
  const newest = new Map<string, RevenueSubscription>();
  for (const sub of subscriptions) {
    const existing = newest.get(sub.business_id);
    if (!existing || Date.parse(sub.created_at) > Date.parse(existing.created_at)) {
      newest.set(sub.business_id, sub);
    }
  }
  return [...newest.values()];
}

/**
 * Was this subscription (approximately) live at instant `at`?
 *
 * Matches `computeDayCurrentMrr`'s revenue definition: only `active` rows
 * count (a `past_due` row isn't collecting money, and the headline Est. MRR
 * excludes it — counting it here would make the current month's trend bar
 * disagree with the KPI card). `past_due` is legacy-only anyway: payment
 * failures now flip straight to `canceled`.
 */
export function wasSubscriptionActiveAt(sub: RevenueSubscription, at: Date): boolean {
  const created = Date.parse(sub.created_at);
  if (Number.isFinite(created) && created > at.getTime()) return false;
  if (sub.status === "active") return true;
  if (sub.status === "canceled" && sub.canceled_at) {
    const canceled = Date.parse(sub.canceled_at);
    return Number.isFinite(canceled) && canceled > at.getTime();
  }
  return false;
}

function dealStartMs(deal: RevenueDeal): number {
  const activated = deal.activated_at ? Date.parse(deal.activated_at) : NaN;
  if (Number.isFinite(activated)) return activated;
  return Date.parse(deal.created_at);
}

export type MrrTrendPoint = {
  /** e.g. "2026-07" */
  monthKey: string;
  /** e.g. "Jul" */
  label: string;
  totalCents: number;
};

/**
 * MRR evaluated at the end of each of the last `months` calendar months
 * (the current month is evaluated at `now`). Only ACTIVE deals contribute
 * (a canceled deal's end date isn't recorded, so it drops out of history —
 * consistent best-effort drift with the rest of this module).
 */
export function computeMrrTrend(params: {
  subscriptions: RevenueSubscription[];
  deals: RevenueDeal[];
  months?: number;
  now?: Date;
}): MrrTrendPoint[] {
  const now = params.now ?? new Date();
  const months = params.months ?? 6;
  const activeDeals = params.deals.filter((d) => d.status === "active");

  const points: MrrTrendPoint[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() - back;
    // End-of-month anchor: last millisecond of that UTC month, clamped to
    // `now` for the current (still-running) month.
    const monthEnd = new Date(Math.min(Date.UTC(year, month + 1, 1) - 1, now.getTime()));
    const monthStart = new Date(Date.UTC(year, month, 1));

    const subsAtAnchor = dedupeNewestPerBusiness(
      params.subscriptions.filter((sub) => wasSubscriptionActiveAt(sub, monthEnd))
    )
      // computeDayCurrentMrr only counts status==="active"; rows that were
      // live at the anchor but have since canceled are re-labeled for the
      // historical evaluation.
      .map((sub) => ({ ...sub, status: "active" }));
    const dealsAtAnchor = activeDeals.filter((d) => dealStartMs(d) <= monthEnd.getTime());

    const mrr = computeDayCurrentMrr({
      subscriptions: subsAtAnchor,
      enterpriseDeals: dealsAtAnchor,
      now: monthEnd
    });
    points.push({
      monthKey: `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`,
      label: monthStart.toLocaleString("default", { month: "short", timeZone: "UTC" }),
      totalCents: mrr.totalCents
    });
  }
  return points;
}

export type ChurnStats = {
  /** BUSINESSES that churned (canceled in the window, not active now). */
  canceledInWindow: number;
  /** Businesses with a Stripe-backed active subscription right now. */
  activeNow: number;
  /**
   * Churned ÷ customers-at-start-of-period (active + churned), in %. The
   * start-of-period denominator keeps the rate meaningful at the edges: a
   * full wipeout reads 100%, not a divide-by-zero 0%.
   */
  churnRatePct: number;
};

/**
 * Per-BUSINESS churn (the input is `listAllSubscriptions()` — history
 * included — so multiple cancel rows for one tenant must count once, and a
 * tenant that canceled and then resubscribed inside the window didn't
 * churn at all).
 */
export function computeChurnStats(params: {
  subscriptions: RevenueSubscription[];
  windowDays?: number;
  now?: Date;
}): ChurnStats {
  const now = params.now ?? new Date();
  const windowMs = (params.windowDays ?? 30) * 24 * 60 * 60 * 1000;

  const activeBusinesses = new Set<string>();
  const canceledBusinesses = new Set<string>();
  for (const sub of params.subscriptions) {
    // Rows with no Stripe subscription behind them (internal pilots,
    // admin-created accounts) never charged anyone — same exclusion as MRR.
    if (sub.stripe_subscription_id === null) continue;
    if (sub.status === "active") {
      activeBusinesses.add(sub.business_id);
      continue;
    }
    if (sub.status === "canceled" && sub.canceled_at) {
      const canceled = Date.parse(sub.canceled_at);
      if (Number.isFinite(canceled) && now.getTime() - canceled <= windowMs && canceled <= now.getTime()) {
        canceledBusinesses.add(sub.business_id);
      }
    }
  }
  let canceledInWindow = 0;
  for (const businessId of canceledBusinesses) {
    if (!activeBusinesses.has(businessId)) canceledInWindow += 1;
  }
  const activeNow = activeBusinesses.size;
  const startOfPeriod = activeNow + canceledInWindow;
  return {
    canceledInWindow,
    activeNow,
    churnRatePct:
      startOfPeriod > 0 ? Math.round((canceledInWindow / startOfPeriod) * 1000) / 10 : 0
  };
}

/**
 * Average revenue per paying BUSINESS (cents): total per-business revenue ÷
 * unique paying businesses — a tenant with both a subscription and an
 * enterprise deal counts once, matching the Paying Clients KPI (both are
 * derived from the same per-business merge). 0 when nobody pays.
 */
export function computeArpuCents(params: {
  subscriptions: RevenueSubscription[];
  deals: RevenueDeal[];
  now?: Date;
}): number {
  const perBusiness = computeTopBusinessRevenue({
    subscriptions: params.subscriptions,
    deals: params.deals,
    now: params.now,
    limit: Number.MAX_SAFE_INTEGER
  });
  if (perBusiness.length === 0) return 0;
  const totalCents = perBusiness.reduce((sum, row) => sum + row.cents, 0);
  return Math.round(totalCents / perBusiness.length);
}

export type BusinessRevenue = {
  businessId: string;
  cents: number;
  source: "subscription" | "enterprise_deal";
};

/** Per-business day-current monthly revenue, highest first. */
export function computeTopBusinessRevenue(params: {
  subscriptions: RevenueSubscription[];
  deals: RevenueDeal[];
  now?: Date;
  limit?: number;
}): BusinessRevenue[] {
  const byBusiness = new Map<string, BusinessRevenue>();

  for (const sub of dedupeNewestPerBusiness(params.subscriptions)) {
    const mrr = computeDayCurrentMrr({
      subscriptions: [sub],
      enterpriseDeals: [],
      now: params.now
    });
    if (mrr.subscriptionCents <= 0) continue;
    const existing = byBusiness.get(sub.business_id);
    byBusiness.set(sub.business_id, {
      businessId: sub.business_id,
      cents: (existing?.cents ?? 0) + mrr.subscriptionCents,
      source: existing?.source ?? "subscription"
    });
  }

  for (const deal of params.deals) {
    if (deal.status !== "active") continue;
    const existing = byBusiness.get(deal.business_id);
    byBusiness.set(deal.business_id, {
      businessId: deal.business_id,
      cents: (existing?.cents ?? 0) + deal.monthly_cents,
      source: existing?.source ?? "enterprise_deal"
    });
  }

  return [...byBusiness.values()]
    .sort((a, b) => b.cents - a.cents)
    .slice(0, params.limit ?? 10);
}

export type PaymentProblem = {
  businessId: string;
  kind: "past_due" | "payment_failed";
  /** When the problem was recorded (canceled_at for failed payments). */
  at: string | null;
};

/**
 * The failed-payments report: `past_due` rows plus cancels whose recorded
 * reason was a payment failure, newest first. Only each business's NEWEST
 * subscription row is considered — a tenant that recovered onto a newer
 * active subscription is a resolved problem, not a current one.
 */
export function listPaymentProblems(subscriptions: RevenueSubscription[]): PaymentProblem[] {
  const problems: PaymentProblem[] = [];
  for (const sub of dedupeNewestPerBusiness(subscriptions)) {
    if (sub.status === "past_due") {
      problems.push({ businessId: sub.business_id, kind: "past_due", at: sub.created_at });
    } else if (sub.status === "canceled" && sub.cancel_reason === "payment_failed") {
      problems.push({
        businessId: sub.business_id,
        kind: "payment_failed",
        at: sub.canceled_at
      });
    }
  }
  return problems.sort((a, b) => {
    const am = a.at ? Date.parse(a.at) : 0;
    const bm = b.at ? Date.parse(b.at) : 0;
    return bm - am;
  });
}
