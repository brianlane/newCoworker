/**
 * Resolve a Hostinger box's paid-through date from its billing subscription.
 *
 * `vps_inventory.expires_at` is the runway signal the adopt-first claim ranks
 * on (furthest expiry wins, and anything under 72h is skipped), but the two
 * moments that MOVE a box in or out of the pool, a purchase and a cancel,
 * both used to write the row without it, leaving `expires_at` null until the
 * daily billing-posture cron caught up. Null sorts last, so for up to a day a
 * box with 23 months of prepaid runway could lose the ranking to one with a
 * known but shorter expiry.
 *
 * This is the shared lookup those two paths use. It is deliberately
 * best-effort and returns null rather than throwing: the pool is an economics
 * optimization, so a Hostinger outage must degrade to "unknown expiry, the
 * posture cron will fill it in" and never fail a purchase or a cancel.
 */

import { paidThroughFromBillingSub } from "@/lib/db/vps-inventory";
import { logger } from "@/lib/logger";
import type { BillingSubscription } from "./client";

export type BillingSubscriptionLister = {
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
};

/**
 * Paid-through for `billingSubscriptionId`, or null when it cannot be
 * resolved (no id, lookup failed, subscription not in the list, or Hostinger
 * returned neither `expires_at` nor `next_billing_at`).
 *
 * Callers pass the result straight to `recordVpsAssigned` /
 * `releaseVpsToPool`. Both treat `undefined` as "leave the stored value
 * alone", so a caller that wants that behavior should skip the field rather
 * than forwarding this function's null.
 */
export async function resolvePaidThroughForBillingSub(
  client: BillingSubscriptionLister,
  billingSubscriptionId: string | null | undefined,
  context: Record<string, unknown> = {}
): Promise<string | null> {
  if (!billingSubscriptionId) return null;
  try {
    const subs = await client.listBillingSubscriptions();
    const match = subs.find((sub) => sub.id === billingSubscriptionId);
    if (!match) return null;
    return paidThroughFromBillingSub(match);
  } catch (err) {
    logger.warn("paid-through lookup failed; leaving pool expiry to the posture cron", {
      ...context,
      billingSubscriptionId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
