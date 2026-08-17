/**
 * Is this `customer.subscription.deleted` a tenant leaving, or a plan change?
 *
 * A change-plan cancels the OLD Stripe subscription and builds a new one, so
 * Stripe delivers a deletion event for a tenant who is still very much active,
 * just on a different plan. Anything in that handler that tears down tenant
 * state (disabling auto-reload, cancelling add-ons, stopping boxes) has to tell
 * the two apart or it fires on every upgrade and downgrade.
 *
 * **`cancel_reason` alone is not enough, and the ordering is the trap.** The
 * orchestrator cancels the old Stripe subscription at step 6
 * (`cancelStripeSubscriptionSafely`) and only marks the old row
 * `canceled` / `upgrade_switch` at step 8, with the slow box teardown in
 * between: SSH stop, Hostinger auto-renew off, an ops email. Stripe's webhook
 * typically lands within seconds of step 6, so at read time the old row is
 * usually still `status: "active"` with a null `cancel_reason`, and a check
 * that only looks at those fields misses the very case it was written for.
 *
 * The reliable signal is the REPLACEMENT: step 5 creates the new subscription
 * row, active and carrying a different Stripe id, BEFORE step 6 cancels the old
 * one. So if the business's newest row is active and points at a different
 * Stripe subscription, the tenant has already moved and this deletion is a
 * switch. That holds no matter how the two writes interleave.
 *
 * Both signals are accepted: the replacement check covers the race, and the
 * `cancel_reason` check still covers a webhook delivered late (after step 8) or
 * replayed long afterwards.
 */

export type UpgradeSwitchDeletionInput = {
  /** The Stripe subscription id the deletion event is for. */
  deletedStripeSubscriptionId: string;
  /** The local row that deletion resolved to (the OLD subscription). */
  deletedRow: { status: string; cancel_reason?: string | null } | null;
  /**
   * The business's NEWEST subscription row, whatever it is. During a change
   * plan this is the replacement; in an ordinary cancellation it is the same
   * row being deleted.
   */
  newestRow: { status: string; stripe_subscription_id?: string | null } | null;
};

export function isUpgradeSwitchDeletion(input: UpgradeSwitchDeletionInput): boolean {
  // Late or replayed delivery: the orchestrator already finalized the row.
  if (
    input.deletedRow?.status === "canceled" &&
    input.deletedRow.cancel_reason === "upgrade_switch"
  ) {
    return true;
  }

  // The common case: the replacement subscription is already live, so the
  // tenant is active on a different Stripe subscription than the one that just
  // went away.
  const newest = input.newestRow;
  if (!newest || newest.status !== "active") return false;
  const newestStripeId = newest.stripe_subscription_id ?? null;
  if (!newestStripeId) return false;
  return newestStripeId !== input.deletedStripeSubscriptionId;
}
