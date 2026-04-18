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
 */
export function cacheLooksValidForQuotaAfterJitFailure(row: SubscriptionPeriodRow, nowMs: number): boolean {
  if (!row.stripe_current_period_start || !row.stripe_current_period_end) return false;
  if (!row.stripe_subscription_cached_at) return false;
  const endMs = new Date(row.stripe_current_period_end as string).getTime();
  if (nowMs >= endMs + STRIPE_JIT_PROCEED_END_BUFFER_MS) return false;
  const age = nowMs - new Date(row.stripe_subscription_cached_at as string).getTime();
  if (age > STRIPE_CACHE_ABSURD_AGE_MS) return false;
  return true;
}
