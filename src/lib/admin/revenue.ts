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

/** Was this subscription (approximately) live at instant `at`? */
export function wasSubscriptionActiveAt(sub: RevenueSubscription, at: Date): boolean {
  const created = Date.parse(sub.created_at);
  if (Number.isFinite(created) && created > at.getTime()) return false;
  if (sub.status === "active" || sub.status === "past_due") return true;
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

    const subsAtAnchor = params.subscriptions
      .filter((sub) => wasSubscriptionActiveAt(sub, monthEnd))
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
  /** Stripe-backed cancels inside the window. */
  canceledInWindow: number;
  /** Stripe-backed active subscriptions right now. */
  activeNow: number;
  /** BizBlasts semantics: canceled-this-period ÷ currently-active, in %. */
  churnRatePct: number;
};

export function computeChurnStats(params: {
  subscriptions: RevenueSubscription[];
  windowDays?: number;
  now?: Date;
}): ChurnStats {
  const now = params.now ?? new Date();
  const windowMs = (params.windowDays ?? 30) * 24 * 60 * 60 * 1000;

  let canceledInWindow = 0;
  let activeNow = 0;
  for (const sub of params.subscriptions) {
    // Rows with no Stripe subscription behind them (internal pilots,
    // admin-created accounts) never charged anyone — same exclusion as MRR.
    if (sub.stripe_subscription_id === null) continue;
    if (sub.status === "active") {
      activeNow += 1;
      continue;
    }
    if (sub.status === "canceled" && sub.canceled_at) {
      const canceled = Date.parse(sub.canceled_at);
      if (Number.isFinite(canceled) && now.getTime() - canceled <= windowMs && canceled <= now.getTime()) {
        canceledInWindow += 1;
      }
    }
  }
  return {
    canceledInWindow,
    activeNow,
    churnRatePct:
      activeNow > 0 ? Math.round((canceledInWindow / activeNow) * 1000) / 10 : 0
  };
}

/**
 * Average revenue per paying customer (cents): day-current MRR ÷ (counted
 * subscriptions + active enterprise deals). 0 when nobody pays.
 */
export function computeArpuCents(params: {
  subscriptions: RevenueSubscription[];
  deals: RevenueDeal[];
  now?: Date;
}): number {
  const activeDeals = params.deals.filter((d) => d.status === "active");
  const mrr = computeDayCurrentMrr({
    subscriptions: params.subscriptions,
    enterpriseDeals: activeDeals,
    now: params.now
  });
  const payers = mrr.countedSubscriptions + activeDeals.length;
  return payers > 0 ? Math.round(mrr.totalCents / payers) : 0;
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

  for (const sub of params.subscriptions) {
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
 * reason was a payment failure, newest first.
 */
export function listPaymentProblems(subscriptions: RevenueSubscription[]): PaymentProblem[] {
  const problems: PaymentProblem[] = [];
  for (const sub of subscriptions) {
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
