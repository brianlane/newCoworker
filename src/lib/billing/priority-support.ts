/**
 * Priority support add-on: orchestration between Stripe, the mirror table, and
 * the coverage column.
 *
 * The routes stay thin and this module holds the rules, with every dependency
 * injectable so the whole thing is unit-testable without Stripe or Supabase
 * (same shape as contract-term-nudge.ts).
 *
 * Three rules encoded here that are easy to get wrong at a call site:
 *
 *  1. Enterprise can never buy this. Their priority window is permanent, so
 *     charging them $400/month would bill for something they already hold.
 *  2. One live subscription per tenant. The partial unique index in Postgres
 *     is the real guard; this is the friendly check in front of it.
 *  3. Cancelling is always `cancel_at_period_end`, never immediate, EXCEPT on
 *     tenant teardown. Coverage was already stamped to the end of the paid
 *     period and only ever moves forward, so winding down needs no revocation.
 */

import type Stripe from "stripe";
import {
  createPrioritySupportCheckoutSession,
  cancelPrioritySupportSubscription,
  resumePrioritySupportSubscription
} from "@/lib/stripe/client";
import { cancelStripeSubscriptionSafely } from "@/lib/billing/change-plan-orchestrator";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  getLivePrioritySupportSubscription,
  recordPrioritySupportSubscription,
  mirrorPrioritySupportSubscription,
  markPrioritySupportSubscriptionCanceled
} from "@/lib/db/priority-support";
import { extendPrioritySupport } from "@/lib/db/white-glove-offers";
import { clearPrioritySupportNudgeStamp } from "@/lib/db/businesses";
import {
  prioritySupportCoverageUntil,
  prioritySupportPurchasableForTier,
  PRIORITY_SUPPORT_SUBSCRIPTION_KIND
} from "@/lib/plans/priority-support";
import { logger } from "@/lib/logger";

export type PrioritySupportFailure =
  | "not_purchasable_for_tier"
  | "already_subscribed"
  | "no_active_membership"
  | "not_subscribed";

export type PrioritySupportResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PrioritySupportFailure };

export type StartPrioritySupportDeps = {
  getSubscriptionRow?: typeof getSubscription;
  getLiveRow?: typeof getLivePrioritySupportSubscription;
  createCheckout?: typeof createPrioritySupportCheckoutSession;
  resumeSubscription?: typeof resumePrioritySupportSubscription;
  mirror?: typeof mirrorPrioritySupportSubscription;
};

/**
 * What "start priority support" turned out to mean for this tenant.
 *
 * A tenant who cancelled but is still inside the period they paid for has a
 * LIVE `canceling` subscription, so the honest answer to "restart" is to clear
 * `cancel_at_period_end` on the subscription they already have, not to open a
 * second one. Opening a second one is also impossible: the partial unique index
 * allows one live row per business.
 */
export type StartPrioritySupportOutcome =
  | { kind: "checkout"; checkoutUrl: string }
  | { kind: "resumed" };

/**
 * Turn priority support on, by whichever route actually applies.
 *
 * Two outcomes, because "restart" is ambiguous. If the tenant cancelled and is
 * still inside the period they paid for, their subscription is alive and merely
 * winding down, so this RESUMES it (clears `cancel_at_period_end`) and no new
 * charge happens until the normal renewal. Otherwise it hands back a hosted
 * Checkout URL for a fresh subscription.
 *
 * Requires an ACTIVE membership: priority support is an add-on to a live
 * account, and a tenant mid-cancellation should not be starting a second
 * recurring charge. The membership also supplies the Stripe customer, so the
 * add-on lands on the payer that already exists rather than creating a second
 * customer record for the same business.
 */
export async function startPrioritySupport(
  params: {
    businessId: string;
    tier: string | null | undefined;
    /** Owner email on self-serve, admin email when generating a pay link. */
    actorEmail: string;
    userId?: string;
    successUrl: string;
    cancelUrl: string;
  },
  deps: StartPrioritySupportDeps = {}
): Promise<PrioritySupportResult<StartPrioritySupportOutcome>> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const getSubscriptionRow = deps.getSubscriptionRow ?? getSubscription;
  const getLiveRow = deps.getLiveRow ?? getLivePrioritySupportSubscription;
  const createCheckout = deps.createCheckout ?? createPrioritySupportCheckoutSession;
  const resumeSubscription = deps.resumeSubscription ?? resumePrioritySupportSubscription;
  const mirror = deps.mirror ?? mirrorPrioritySupportSubscription;
  /* c8 ignore stop */

  if (!prioritySupportPurchasableForTier(params.tier)) {
    return { ok: false, reason: "not_purchasable_for_tier" };
  }

  const live = await getLiveRow(params.businessId);
  if (live) {
    // Already renewing: nothing to do, and a second subscription would be
    // double-billing (the partial unique index would reject it anyway).
    if (!live.cancel_at_period_end) return { ok: false, reason: "already_subscribed" };
    // Winding down but still inside the paid period: resume in place.
    await resumeSubscription(live.stripe_subscription_id);
    await mirror(live.stripe_subscription_id, {
      status: "active",
      currentPeriodEnd: live.current_period_end ? new Date(live.current_period_end) : null,
      cancelAtPeriodEnd: false
    });
    return { ok: true, value: { kind: "resumed" } };
  }

  const membership = await getSubscriptionRow(params.businessId);
  if (!membership || membership.status !== "active") {
    return { ok: false, reason: "no_active_membership" };
  }

  const session = await createCheckout({
    businessId: params.businessId,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    customerId: membership.stripe_customer_id ?? undefined,
    customerEmail: membership.stripe_customer_id ? undefined : params.actorEmail,
    ...(params.userId ? { userId: params.userId } : {})
  });

  return { ok: true, value: { kind: "checkout", checkoutUrl: session.url } };
}

export type CancelPrioritySupportDeps = {
  getLiveRow?: typeof getLivePrioritySupportSubscription;
  cancelSubscription?: typeof cancelPrioritySupportSubscription;
  mirror?: typeof mirrorPrioritySupportSubscription;
};

/**
 * Wind the add-on down at the end of the paid period. The tenant keeps the
 * coverage they bought; the countdown on their billing page simply stops
 * resetting.
 */
export async function cancelPrioritySupport(
  businessId: string,
  deps: CancelPrioritySupportDeps = {}
): Promise<PrioritySupportResult<{ coverageEndsAt: string | null }>> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const getLiveRow = deps.getLiveRow ?? getLivePrioritySupportSubscription;
  const cancelSubscription = deps.cancelSubscription ?? cancelPrioritySupportSubscription;
  const mirror = deps.mirror ?? mirrorPrioritySupportSubscription;
  /* c8 ignore stop */

  const live = await getLiveRow(businessId);
  if (!live) return { ok: false, reason: "not_subscribed" };

  await cancelSubscription(live.stripe_subscription_id);
  await mirror(live.stripe_subscription_id, {
    status: "canceling",
    currentPeriodEnd: live.current_period_end ? new Date(live.current_period_end) : null,
    cancelAtPeriodEnd: true
  });

  return { ok: true, value: { coverageEndsAt: live.current_period_end } };
}

export type TerminatePrioritySupportDeps = {
  getLiveRow?: typeof getLivePrioritySupportSubscription;
  cancelStripe?: typeof cancelStripeSubscriptionSafely;
  markCanceled?: typeof markPrioritySupportSubscriptionCanceled;
  now?: () => Date;
};

/**
 * Tenant teardown: kill the add-on outright.
 *
 * Called when the MEMBERSHIP is canceled or the tenant is wiped. Without this
 * the priority subscription is a second, independent Stripe subscription that
 * happily keeps charging $400/month to an account with no service behind it.
 *
 * Best effort by contract: it swallows its own errors and returns whether it
 * did anything, because every caller is a teardown path where failing loudly
 * would abort more important work (backups, VM stop, grace bookkeeping).
 */
export async function terminatePrioritySupport(
  businessId: string,
  deps: TerminatePrioritySupportDeps = {}
): Promise<boolean> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const getLiveRow = deps.getLiveRow ?? getLivePrioritySupportSubscription;
  const cancelStripe = deps.cancelStripe ?? cancelStripeSubscriptionSafely;
  const markCanceled = deps.markCanceled ?? markPrioritySupportSubscriptionCanceled;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  try {
    const live = await getLiveRow(businessId);
    if (!live) return false;
    await cancelStripe(live.stripe_subscription_id, businessId);
    await markCanceled(live.stripe_subscription_id, now());
    logger.info("priority_support: canceled on tenant teardown", {
      businessId,
      stripeSubscriptionId: live.stripe_subscription_id
    });
    return true;
  } catch (err) {
    logger.warn("priority_support: teardown cancel failed (non-fatal)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/** True when this Stripe subscription is the priority support add-on. */
export function isPrioritySupportSubscription(
  stripeSubscription: Pick<Stripe.Subscription, "metadata"> | null | undefined
): boolean {
  return stripeSubscription?.metadata?.subscriptionKind === PRIORITY_SUPPORT_SUBSCRIPTION_KIND;
}

/**
 * Period end off a Stripe subscription, tolerating both the top-level shape
 * and the per-item shape Stripe moved to. Mirrors what
 * stripeSubscriptionPeriodCache does for the membership.
 */
export function prioritySupportPeriodEnd(
  stripeSubscription: Stripe.Subscription
): Date | null {
  const raw = stripeSubscription as unknown as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  };
  const seconds =
    typeof raw.current_period_end === "number" && Number.isFinite(raw.current_period_end)
      ? raw.current_period_end
      : raw.items?.data?.[0]?.current_period_end;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

export type RecordPrioritySupportCheckoutDeps = {
  record?: typeof recordPrioritySupportSubscription;
  extend?: typeof extendPrioritySupport;
  clearNudge?: typeof clearPrioritySupportNudgeStamp;
};

/**
 * Webhook path: a priority-support Checkout completed.
 *
 * Records the mirror row and opens coverage in one place, so the first period
 * is stamped even if `invoice.paid` is delayed or lost. The nudge stamp is
 * cleared here so a tenant who lapsed and restarted gets warned again next
 * time; without that, the sweep would treat the old stamp as "already told
 * them" forever.
 */
export async function recordPrioritySupportCheckout(
  params: {
    businessId: string;
    stripeSubscriptionId: string;
    stripeCustomerId: string | null;
    stripeSessionId: string | null;
    periodEnd: Date | null;
    createdBy: string;
  },
  deps: RecordPrioritySupportCheckoutDeps = {}
): Promise<{ duplicate: boolean }> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const record = deps.record ?? recordPrioritySupportSubscription;
  const extend = deps.extend ?? extendPrioritySupport;
  const clearNudge = deps.clearNudge ?? clearPrioritySupportNudgeStamp;
  /* c8 ignore stop */

  const { duplicate } = await record({
    businessId: params.businessId,
    stripeSubscriptionId: params.stripeSubscriptionId,
    stripeCustomerId: params.stripeCustomerId,
    stripeSessionId: params.stripeSessionId,
    currentPeriodEnd: params.periodEnd,
    createdBy: params.createdBy
  });

  if (params.periodEnd) {
    await extend(params.businessId, prioritySupportCoverageUntil(params.periodEnd));
    await clearNudge(params.businessId);
  }

  return { duplicate };
}

export type ApplyPrioritySupportInvoiceDeps = {
  extend?: typeof extendPrioritySupport;
  mirror?: typeof mirrorPrioritySupportSubscription;
  clearNudge?: typeof clearPrioritySupportNudgeStamp;
};

/**
 * Webhook path: a priority-support invoice was paid (first charge or renewal).
 *
 * Pushes coverage to this period's end plus grace through the MONOTONIC
 * `extendPrioritySupport`, so a webhook retry, or a longer white-glove window
 * running concurrently, can never shorten coverage the tenant paid for.
 *
 * Coverage is stamped from the subscription's PERIOD END, never from the
 * invoice amount, so the logic is identical on every invoice.
 */
export async function applyPrioritySupportInvoicePaid(
  params: {
    businessId: string;
    stripeSubscription: Stripe.Subscription;
  },
  deps: ApplyPrioritySupportInvoiceDeps = {}
): Promise<boolean> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const extend = deps.extend ?? extendPrioritySupport;
  const mirror = deps.mirror ?? mirrorPrioritySupportSubscription;
  const clearNudge = deps.clearNudge ?? clearPrioritySupportNudgeStamp;
  /* c8 ignore stop */

  const periodEnd = prioritySupportPeriodEnd(params.stripeSubscription);
  if (!periodEnd) {
    logger.warn("priority_support: paid invoice with no resolvable period end", {
      businessId: params.businessId,
      stripeSubscriptionId: params.stripeSubscription.id
    });
    return false;
  }

  await extend(params.businessId, prioritySupportCoverageUntil(periodEnd));
  await mirror(params.stripeSubscription.id, {
    status: params.stripeSubscription.cancel_at_period_end ? "canceling" : "active",
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: Boolean(params.stripeSubscription.cancel_at_period_end)
  });
  await clearNudge(params.businessId);
  return true;
}
