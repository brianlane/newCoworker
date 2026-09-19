/**
 * Payment-failure cancel helpers.
 *
 * Scar Fairy (Sep 16 2026): `invoice.payment_failed` dispatched
 * `autoCancelOnPaymentFailure`, which called Stripe
 * `subscriptions.cancel` BEFORE writing `cancel_reason=payment_failed`.
 * Stripe then emitted `customer.subscription.updated` / `.deleted` with
 * `cancellation_details.reason = cancellation_requested` (that is what an
 * API cancel looks like, not a customer clicking Cancel). Those handlers
 * raced the still-active row and the deleted fallback PATCHed
 * `cancel_reason: existing.cancel_reason` while `existing` was still
 * null. Result: status=canceled, cancel_reason NULL, grace +30d.
 *
 * Stamp `payment_failed` first, and never PATCH cancel_reason to null.
 */

import { GRACE_WINDOW_MS } from "@/lib/billing/lifecycle";
import { updateSubscription, type SubscriptionRow } from "@/lib/db/subscriptions";

export type InvoicePaymentFailureDetails = {
  invoiceId: string;
  amountCents: number | null;
  currency: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  declineCode: string | null;
  failureCode: string | null;
  failureMessage: string | null;
};

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as LooseRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cardFromCharge(charge: LooseRecord | null): {
  cardBrand: string | null;
  cardLast4: string | null;
  declineCode: string | null;
  failureCode: string | null;
  failureMessage: string | null;
} {
  const details = asRecord(charge?.payment_method_details);
  const card = asRecord(details?.card);
  const outcome = asRecord(charge?.outcome);
  return {
    cardBrand: asString(card?.brand),
    cardLast4: asString(card?.last4),
    declineCode: asString(outcome?.reason) ?? asString(charge?.failure_code),
    failureCode: asString(charge?.failure_code),
    failureMessage: asString(charge?.failure_message)
  };
}

function errorFromIntent(intent: LooseRecord | null): {
  declineCode: string | null;
  failureCode: string | null;
  failureMessage: string | null;
} {
  const err = asRecord(intent?.last_payment_error);
  return {
    declineCode: asString(err?.decline_code),
    failureCode: asString(err?.code),
    failureMessage: asString(err?.message)
  };
}

/**
 * Pull the human-useful decline facts off a Stripe Invoice without
 * requiring expansions. Accepts the live Invoice shape and the thinner
 * objects webhook tests pass.
 */
export function invoicePaymentFailureDetails(invoice: {
  id?: string | null;
  amount_due?: number | null;
  amount_remaining?: number | null;
  currency?: string | null;
  charge?: unknown;
  last_finalization_error?: { code?: string | null; message?: string | null } | null;
  payments?: { data?: unknown[] } | null;
}): InvoicePaymentFailureDetails {
  const charge = asRecord(invoice.charge);
  const fromCharge = cardFromCharge(charge);

  let fromIntent = errorFromIntent(null);
  const payments = invoice.payments?.data ?? [];
  for (const row of payments) {
    const rec = asRecord(row);
    const payment = asRecord(rec?.payment);
    const intent = asRecord(payment?.payment_intent) ?? asRecord(rec?.payment_intent);
    const parsed = errorFromIntent(intent);
    if (parsed.failureCode || parsed.declineCode || parsed.failureMessage) {
      fromIntent = parsed;
      break;
    }
  }

  const finalization = invoice.last_finalization_error;
  const amount =
    typeof invoice.amount_due === "number"
      ? invoice.amount_due
      : typeof invoice.amount_remaining === "number"
        ? invoice.amount_remaining
        : null;

  return {
    invoiceId: asString(invoice.id) ?? "",
    amountCents: amount,
    currency: asString(invoice.currency),
    cardBrand: fromCharge.cardBrand,
    cardLast4: fromCharge.cardLast4,
    declineCode:
      fromIntent.declineCode ?? fromCharge.declineCode ?? asString(finalization?.code),
    failureCode:
      fromIntent.failureCode ?? fromCharge.failureCode ?? asString(finalization?.code),
    failureMessage:
      fromIntent.failureMessage ??
      fromCharge.failureMessage ??
      asString(finalization?.message)
  };
}

/** One-line owner/ops summary, e.g. "Amex ending 3042, declined (do_not_honor)". */
export function formatPaymentFailureDetail(details: InvoicePaymentFailureDetails): string {
  const card =
    details.cardLast4 && details.cardBrand
      ? `${capitalizeBrand(details.cardBrand)} ending ${details.cardLast4}`
      : details.cardLast4
        ? `card ending ${details.cardLast4}`
        : null;
  const codes = [details.failureCode, details.declineCode]
    .filter((c, i, all): c is string => Boolean(c) && all.indexOf(c) === i)
    .join(" / ");
  const parts = [card, codes ? `declined (${codes})` : details.failureMessage].filter(
    (p): p is string => Boolean(p)
  );
  return parts.length > 0 ? parts.join(", ") : "the charge was declined";
}

function capitalizeBrand(brand: string): string {
  if (brand.toLowerCase() === "amex") return "Amex";
  if (brand.toLowerCase() === "mastercard") return "Mastercard";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export type PaymentFailedCancelPatch = {
  status: "canceled";
  cancel_reason: "payment_failed";
  canceled_at: string;
  grace_ends_at: string;
  cancel_at_period_end: false;
  stripe_current_period_start: null;
  stripe_current_period_end: null;
  stripe_subscription_cached_at: string;
};

/** DB patch written BEFORE Stripe cancel so webhook mirrors cannot race a null reason. */
export function paymentFailedCancelPatch(now: Date): PaymentFailedCancelPatch {
  return {
    status: "canceled",
    cancel_reason: "payment_failed",
    canceled_at: now.toISOString(),
    grace_ends_at: new Date(now.getTime() + GRACE_WINDOW_MS).toISOString(),
    cancel_at_period_end: false,
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: now.toISOString()
  };
}

export async function stampPaymentFailedCancel(
  row: Pick<SubscriptionRow, "id">,
  now: Date = new Date(),
  update: typeof updateSubscription = updateSubscription
): Promise<void> {
  await update(row.id, paymentFailedCancelPatch(now));
}

export type CanceledMirrorExisting = {
  cancel_reason: string | null;
  canceled_at: string | null;
  grace_ends_at: string | null;
  wiped_at: string | null;
};

/**
 * Fallback PATCH for `customer.subscription.deleted`.
 * Deliberately omits `cancel_reason` when the loaded row has null, so a
 * concurrent `payment_failed` stamp is not overwritten to null.
 */
export function canceledMirrorPatch(args: {
  now: Date;
  existing: CanceledMirrorExisting;
}): {
  status: "canceled";
  stripe_current_period_start: null;
  stripe_current_period_end: null;
  stripe_subscription_cached_at: string;
  grace_ends_at: string | null;
  canceled_at: string;
  cancel_at_period_end: false;
  cancel_reason?: string;
} {
  const { now, existing } = args;
  const graceEndsAt =
    existing.grace_ends_at ??
    (existing.wiped_at ? null : new Date(now.getTime() + GRACE_WINDOW_MS).toISOString());
  return {
    status: "canceled",
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: now.toISOString(),
    grace_ends_at: graceEndsAt,
    canceled_at: existing.canceled_at ?? now.toISOString(),
    cancel_at_period_end: false,
    ...(existing.cancel_reason != null ? { cancel_reason: existing.cancel_reason } : {})
  };
}
