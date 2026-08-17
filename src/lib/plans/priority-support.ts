/**
 * Priority support coverage: the sellable $400/month add-on.
 *
 * Priority call/video support already existed as an entitlement
 * (`businesses.priority_support_until`, gated by `hasPrioritySupportForTier`
 * in white-glove.ts), but only as a free 30-day rider on a white-glove
 * package purchase, plus a permanent grant for enterprise. This module makes
 * it something a tenant can actually buy on its own.
 *
 * Billing shape: its OWN month-to-month Stripe subscription on the tenant's
 * existing customer, never a line item on the membership subscription.
 *
 * That choice was originally justified as "Stripe requires every item on one
 * subscription to share a billing interval, so a monthly line cannot ride a
 * 12/24-month membership". **That is false**, verified against the live API on
 * 2026-08-17 (debug/priority-support-stripe-testmode.ts). Stripe's actual rule,
 * quoted from its own error, is that each item's recurring period must be a
 * MULTIPLE OF THE SHORTEST one. So `month/1` alongside `month/24` is accepted
 * and bills on its own cadence; only non-divisible pairs like month + week are
 * refused. A line item on the membership would have worked.
 *
 * The reasons it stays separate are lifecycle ones, and they are the load
 * bearing ones:
 *
 *  - **Change-plan rebuilds the membership.** It cancels the old Stripe
 *    subscription and creates a new one from the selector's lines alone, so a
 *    line item would be destroyed on every upgrade unless explicitly carried.
 *    That is the bug migration 20260822034834 exists for, on usage packs.
 *  - **You cannot add one mid-term anyway.** Change-plan refuses with a 409
 *    `plan_unchanged` when tier and period are unchanged, so an existing
 *    tenant could not buy it without also switching plans.
 *  - **The 30-day refund carve-out matches lines on the membership invoice.**
 *    A priority line would need its own carve-out rule or it would be refunded
 *    along with the plan. Separate invoices are structurally outside it.
 *  - **Independent lifecycle:** support can be cancelled without touching the
 *    plan, and it survives a plan change untouched.
 *
 * Riding it at the plan's cadence (what the usage packs do) would additionally
 * prepay support for the whole term and lock the tenant in, which inverts the
 * product rule: cancel any month, never locked in.
 *
 * The subscription starts the day it is bought and renews on that anniversary.
 * It is deliberately NOT anchored to the membership bill date: no proration,
 * no partial-period charges, and a coverage window that is always a clean
 * month. The tradeoff is a second bill date, which the billing copy states.
 *
 * Coverage state lives in two layers: Stripe answers "is this renewing", and
 * `businesses.priority_support_until` answers "how many days are left". Each
 * paid invoice pushes the column forward to that period's end plus a grace
 * window. Because the column only ever moves forward on payment, cancelling
 * needs no revocation step: coverage runs to the end of the period already
 * paid for, then lapses on its own.
 *
 * Pure module (no server imports) so both the dashboard card and the admin
 * panel can run the same status math the routes bill from.
 */

import type { PlanTier } from "./tier";

/** Flat monthly price, all tiers. Never discounted by billing period: this is
 *  a service fee billed month to month, not a usage pack. */
export const PRIORITY_SUPPORT_MONTHLY_CENTS = 40_000;

/**
 * Product name on the Stripe line item: the customer-visible label on
 * checkout, invoices, and the billing portal. Also the sentinel for finding
 * the line on an invoice, same pattern as CARRIER_REGISTRATION_FEE_NAME and
 * MEXICO_MESSAGING_FEE_NAME.
 */
export const PRIORITY_SUPPORT_LINE_NAME = "Priority support coverage";

/**
 * Metadata marker stamped on the Stripe SUBSCRIPTION (not just the checkout
 * session) so the webhook can tell this subscription apart from the tenant's
 * membership. Load-bearing: `invoice.paid` resolves an unrecognized
 * subscription by its `businessId` metadata and would otherwise overwrite the
 * membership's cached billing period with this one's monthly window.
 */
export const PRIORITY_SUPPORT_SUBSCRIPTION_KIND = "priority_support";

/** Checkout session metadata marker, dispatched on by the webhook. */
export const PRIORITY_SUPPORT_CHECKOUT_KIND = "priority_support";

/**
 * Slack added to each paid period before coverage lapses, so a slow renewal
 * webhook cannot blink support off for a paying tenant. Matches the 3-day
 * COVERAGE_SLACK_MS convention in vps/contract-coverage.ts.
 */
export const PRIORITY_SUPPORT_COVERAGE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** At or below this many days left, the surfaces render an amber warning. */
export const PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Coverage end for a paid period: the Stripe period end plus grace. Callers
 * pass the period end from the live subscription, so a missed webhook
 * self-corrects on the next paid invoice rather than compounding.
 */
export function prioritySupportCoverageUntil(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() + PRIORITY_SUPPORT_COVERAGE_GRACE_MS);
}

/**
 * Whole days of coverage remaining, rounded up, or null when a countdown is
 * meaningless.
 *
 * Null (not 0) for enterprise: their window is PERMANENT and their
 * `priority_support_until` is typically unset, so a naive countdown would
 * render "0 days left" for the tenants with the strongest entitlement.
 * Null too for a tenant with no coverage at all, so callers must distinguish
 * "no countdown to show" from "expiring today" rather than defaulting.
 */
export function prioritySupportDaysLeft(
  tier: PlanTier | string | null | undefined,
  prioritySupportUntilIso: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (tier === "enterprise") return null;
  if (!prioritySupportUntilIso) return null;
  const until = new Date(prioritySupportUntilIso);
  if (Number.isNaN(until.getTime())) return null;
  const remainingMs = until.getTime() - now.getTime();
  if (remainingMs <= 0) return 0;
  return Math.max(0, Math.ceil(remainingMs / DAY_MS));
}

export type PrioritySupportStatus =
  /** Enterprise: permanent, no countdown, never billed this add-on. */
  | "permanent"
  /** Covered with more than the low-days threshold remaining. */
  | "active"
  /** Covered, but at or under the threshold. Render amber. */
  | "expiring_soon"
  /** Had coverage, the window has closed. */
  | "expired"
  /** Never had coverage. */
  | "none";

/**
 * The single status any surface renders from, so the dashboard card, the
 * admin panel, and the clients-list badge cannot drift apart.
 */
export function prioritySupportStatus(
  tier: PlanTier | string | null | undefined,
  prioritySupportUntilIso: string | null | undefined,
  now: Date = new Date()
): PrioritySupportStatus {
  if (tier === "enterprise") return "permanent";
  if (!prioritySupportUntilIso) return "none";
  const until = new Date(prioritySupportUntilIso);
  if (Number.isNaN(until.getTime())) return "none";
  const daysLeft = prioritySupportDaysLeft(tier, prioritySupportUntilIso, now);
  if (daysLeft === null || daysLeft <= 0) return "expired";
  return daysLeft <= PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD ? "expiring_soon" : "active";
}

/**
 * What the Dashboard billing card should render.
 *
 * The precedence is the whole point, and it has bitten twice:
 *
 * - A live subscription row WINS over the coverage window. A tenant whose
 *   subscription is renewing is being charged $400/month right now, so Cancel
 *   has to be reachable even if `priority_support_until` is missing or stale
 *   (a lost `invoice.paid`, or the gap before the first stamp). Deciding from
 *   coverage alone leaves them billed with no self-serve way to stop.
 * - With NO row, the coverage window still decides. An admin comp, a
 *   white-glove rider, or the period already paid for after cancelling are all
 *   real coverage; reading those as lapsed tells a covered tenant their
 *   support has ended and offers to sell it back to them.
 *
 * Enterprise is not modeled here: the billing page hides the card for them
 * entirely, since their window is permanent and included.
 */
export type PrioritySupportCardState = "none" | "renewing" | "winding_down" | "lapsed";

export function prioritySupportCardState(input: {
  /** The tenant's live subscription row, if any. */
  subscription: { cancel_at_period_end: boolean } | null;
  tier: PlanTier | string | null | undefined;
  prioritySupportUntilIso: string | null | undefined;
  now?: Date;
}): PrioritySupportCardState {
  if (input.subscription) {
    return input.subscription.cancel_at_period_end ? "winding_down" : "renewing";
  }
  const status = prioritySupportStatus(
    input.tier,
    input.prioritySupportUntilIso,
    input.now ?? new Date()
  );
  if (prioritySupportStatusIsCovered(status)) return "winding_down";
  return input.prioritySupportUntilIso ? "lapsed" : "none";
}

/** True when the status means the tenant currently HAS priority support. */
export function prioritySupportStatusIsCovered(status: PrioritySupportStatus): boolean {
  return status === "permanent" || status === "active" || status === "expiring_soon";
}

/**
 * Enterprise already holds a permanent window, so selling them the add-on
 * would charge for something they have. API boundaries fail closed on this.
 */
export function prioritySupportPurchasableForTier(
  tier: PlanTier | string | null | undefined
): boolean {
  return tier === "starter" || tier === "standard";
}
