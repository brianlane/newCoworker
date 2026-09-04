/** Stripe subscription period cache + §4.2 JIT refresh heuristics (voice Edge). */

export const STRIPE_PERIOD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Plan §4.2(a): still trust cache if we are not past period end + this buffer. */
export const STRIPE_JIT_PROCEED_END_BUFFER_MS = 15 * 60 * 1000;
export const STRIPE_PERIOD_ROLLOVER_GRACE_MS = 120_000;
/** Reject “proceed on stale cache” if subscription cache timestamp is older than this. */
export const STRIPE_CACHE_ABSURD_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type SubscriptionPeriodRow = {
  id: string;
  stripe_subscription_id: string | null;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  stripe_subscription_cached_at: string | null;
};

/**
 * The billing cadence of the row, as stored in `subscriptions.billing_period`.
 * Anything we don't recognise is treated as monthly, the conservative end.
 */
export type SubscriptionBillingPeriod = string | null | undefined;

/**
 * Pull the current billing period (epoch SECONDS) off a Stripe Subscription,
 * accepting both API shapes.
 *
 * Stripe API version `2025-03-31.basil` moved `current_period_start` /
 * `current_period_end` OFF the top-level Subscription and ONTO each
 * `SubscriptionItem`. Our SDK is pinned past that (`2026-08-26.dahlia`) and the
 * live account default is `2026-03-25.dahlia`, so a raw REST GET that sends no
 * `Stripe-Version` header ALSO receives the new shape: the top-level fields are
 * simply absent. Reading only the top level silently yields `null` on every
 * modern response, which is exactly how the voice JIT period refresh broke.
 *
 *   1. Top-level `sub.current_period_{start,end}` (legacy / pinned API ≤ 2025-03-30).
 *   2. `sub.items.data[].current_period_{start,end}` (basil and later), taking the
 *      subscription-wide window as `[min(start), max(end)]` across items. For the
 *      common single-item subscription this is identical to the old fields.
 *
 * Returns `null` when neither shape yields two finite numbers. Never throws, so
 * it is safe to point at an arbitrary parsed JSON body.
 *
 * This module is the SINGLE definition of that shape rule: the Node app
 * (`src/lib/db/subscriptions.ts`) imports it too, so the Edge reader and the
 * webhook reader cannot drift apart again.
 */
export function stripeSubscriptionPeriodSeconds(
  sub: unknown
): { start: number; end: number } | null {
  if (sub == null || typeof sub !== "object") return null;
  const s = sub as {
    current_period_start?: unknown;
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_start?: unknown; current_period_end?: unknown }> };
  };

  if (typeof s.current_period_start === "number" && typeof s.current_period_end === "number") {
    if (Number.isFinite(s.current_period_start) && Number.isFinite(s.current_period_end)) {
      return { start: s.current_period_start, end: s.current_period_end };
    }
  }

  const items = s.items?.data;
  if (!Array.isArray(items) || items.length === 0) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const it of items) {
    if (typeof it.current_period_start === "number" && Number.isFinite(it.current_period_start)) {
      starts.push(it.current_period_start);
    }
    if (typeof it.current_period_end === "number" && Number.isFinite(it.current_period_end)) {
      ends.push(it.current_period_end);
    }
  }
  if (starts.length === 0 || ends.length === 0) return null;
  return { start: Math.min(...starts), end: Math.max(...ends) };
}

/**
 * How stale `stripe_subscription_cached_at` may be before we refuse to honor
 * the cached period after a failed JIT refresh.
 *
 * The 30-day default was written for MONTHLY billing, where a renewal webhook
 * re-stamps the cache every cycle: a cache older than a full cycle means
 * something is genuinely broken, and refusing is right.
 *
 * Annual and biennial plans are PREPAID for the whole period and produce no
 * renewal webhook for a year or more, so their cache age says nothing at all
 * about whether the tenant is paid up. Judging them by the monthly yardstick
 * refuses calls from customers who are, by construction, paid in full. The
 * risk a stale cache carries for them is already bounded by the two checks
 * that follow: `stripe_current_period_end` must exist, and the caller refuses
 * outright once we are past it. So give a term plan its own term length plus
 * the same 30-day grace a monthly plan gets.
 *
 * Unknown/absent cadences fall back to the monthly cap, the conservative end.
 */
export function stripeCacheMaxAgeMs(billingPeriod: SubscriptionBillingPeriod): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (billingPeriod === "annual") return STRIPE_CACHE_ABSURD_AGE_MS + 365 * DAY_MS;
  if (billingPeriod === "biennial") return STRIPE_CACHE_ABSURD_AGE_MS + 730 * DAY_MS;
  return STRIPE_CACHE_ABSURD_AGE_MS;
}

export function subscriptionPeriodNeedsRefresh(row: SubscriptionPeriodRow, stripeSecret: string): boolean {
  if (!stripeSecret || !row.stripe_subscription_id) return false;
  const now = Date.now();
  if (!row.stripe_current_period_start || !row.stripe_current_period_end) return true;
  if (row.stripe_subscription_cached_at) {
    const age = now - new Date(row.stripe_subscription_cached_at as string).getTime();
    if (age > STRIPE_PERIOD_CACHE_TTL_MS) return true;
  } else {
    return true;
  }
  const endMs = new Date(row.stripe_current_period_end as string).getTime();
  if (now > endMs + STRIPE_PERIOD_ROLLOVER_GRACE_MS) return true;
  return false;
}

/**
 * §4.2(a): after a failed JIT fetch, only proceed if cache still plausibly describes the active period.
 *
 * `billingPeriod` selects the max cache age (see `stripeCacheMaxAgeMs`); omit
 * it to keep the monthly 30-day rule.
 */
export function cacheLooksValidForQuotaAfterJitFailure(
  row: SubscriptionPeriodRow,
  nowMs: number,
  billingPeriod?: SubscriptionBillingPeriod
): boolean {
  if (!row.stripe_current_period_start || !row.stripe_current_period_end) return false;
  if (!row.stripe_subscription_cached_at) return false;
  const endMs = new Date(row.stripe_current_period_end as string).getTime();
  if (nowMs >= endMs + STRIPE_JIT_PROCEED_END_BUFFER_MS) return false;
  const age = nowMs - new Date(row.stripe_subscription_cached_at as string).getTime();
  if (age > stripeCacheMaxAgeMs(billingPeriod)) return false;
  return true;
}
