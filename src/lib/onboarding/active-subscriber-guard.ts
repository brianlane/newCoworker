/**
 * Server-side onboarding entry guard.
 *
 * A signed-in owner whose business already has live/paid service must never
 * re-enter the onboarding flow: resuming a stale onboarding draft against an
 * existing business once overwrote a live tenant's agent config and shadowed
 * its active subscription with a stray `pending` row (the "Amy reset"
 * incident). Plan changes and reactivation live on /dashboard/billing.
 *
 * This is the UX half of the guard — the hard stop is the 409 in
 * /api/checkout — so a transient DB read error FAILS OPEN (returns false)
 * rather than locking brand-new signups out of onboarding.
 */
import { getAuthUser } from "@/lib/auth";
import { listBusinessIdsByOwnerEmail } from "@/lib/db/businesses";
import { findCheckoutBlockingSubscription } from "@/lib/db/subscriptions";
import { logger } from "@/lib/logger";

export async function hasActiveSubscriptionForCurrentUser(): Promise<boolean> {
  const user = await getAuthUser();
  if (!user?.email) return false;
  try {
    const businessIds = await listBusinessIdsByOwnerEmail(user.email);
    if (businessIds.length === 0) return false;
    return (await findCheckoutBlockingSubscription(businessIds)) !== null;
  } catch (err) {
    logger.warn("onboarding active-subscriber guard read failed; failing open", {
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}
