import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import {
  stripeSubscriptionPeriodCache,
  type SubscriptionRow
} from "@/lib/db/subscriptions";
import { logger } from "@/lib/logger";

type RenewalSubscription = Pick<
  SubscriptionRow,
  "status" | "stripe_subscription_id" | "stripe_current_period_end" | "renewal_at"
>;

export type ResolveRenewalOptions = {
  /** Injectable for tests; defaults to the configured Stripe client. */
  stripe?: Pick<Stripe, "subscriptions">;
  now?: Date;
  /** Max time to wait on the live Stripe retrieve before falling back. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 2500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stripe_renewal_timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Resolve the "Next renewal" date to show on the billing page for an ACTIVE
 * subscription.
 *
 * Why this exists: the page historically showed `subscriptions.renewal_at`,
 * which is computed once at signup/plan-change and never advanced — so after
 * the first monthly cycle it renders a date in the past even though the
 * subscription is healthy. Stripe's `current_period_end` is the real rolling
 * next-charge boundary (correct for monthly, annual, and biennial alike).
 *
 * TTFB-aware strategy (the billing route is already the slowest page, see the
 * auth round-trip work):
 *   1. If the cached `stripe_current_period_end` is still in the FUTURE, it's
 *      fresh (webhooks keep it current) — use it with NO network call.
 *   2. Only when the cache is missing or already elapsed do we fetch the live
 *      subscription from Stripe, bounded by a short timeout.
 *   3. On any failure/timeout, fall back to the cached value, then `renewal_at`.
 *
 * Returns an ISO timestamp string, or null when nothing is resolvable.
 */
export async function resolveActiveRenewalDate(
  sub: RenewalSubscription | null,
  options: ResolveRenewalOptions = {}
): Promise<string | null> {
  if (!sub) return null;
  const now = options.now ?? new Date();
  const cachedEnd = sub.stripe_current_period_end ?? null;
  const fallback = cachedEnd ?? sub.renewal_at ?? null;

  // Live refresh only makes sense for an active sub we can look up in Stripe.
  if (sub.status !== "active" || !sub.stripe_subscription_id) {
    return fallback;
  }

  // Cache is fresh (period end in the future) — webhooks already advanced it.
  if (cachedEnd && new Date(cachedEnd).getTime() > now.getTime()) {
    return cachedEnd;
  }

  // Cache missing or stale → fetch the live period end, bounded.
  try {
    const stripe = options.stripe ?? getStripe();
    const live = await withTimeout(
      stripe.subscriptions.retrieve(sub.stripe_subscription_id),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const period = stripeSubscriptionPeriodCache(live);
    const liveEnd =
      "stripe_current_period_end" in period ? period.stripe_current_period_end : null;
    return liveEnd ?? fallback;
  } catch (err) {
    logger.warn("billing: live renewal lookup failed; using cached value", {
      stripeSubscriptionId: sub.stripe_subscription_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return fallback;
  }
}
