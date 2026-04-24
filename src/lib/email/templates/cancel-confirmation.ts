/**
 * Transactional email: cancel-confirmation.
 *
 * Sent by the lifecycle executor on every cancel action
 * (`cancelWithRefund`, `cancelAtPeriodEnd`, `autoCancelOnPaymentFailure`,
 * `adminForceCancel`). Copy branches on the cancel reason so the tenant
 * gets an accurate account of what just happened and what they can do
 * next (undo, reactivate, or just let the wipe clock run out).
 *
 * Intentionally plain-text — the surrounding mailer (`sendOwnerEmail`
 * via Resend) handles wrapping, From/Reply-To headers, and deliverability.
 *
 * Keep this file deterministic and input-pure: no DB reads, no `Date.now()`,
 * no env lookups. Easy to snapshot-test and reason about.
 */

import type { CancelReason } from "@/lib/db/subscriptions";

export type CancelConfirmationInput = {
  reason: CancelReason;
  /** ISO timestamp when the cancel takes effect (today for refund/admin/payment; period_end date for scheduled). */
  effectiveAt: string;
  /** ISO timestamp when data will be wiped, or null for scheduled-period-end (grace starts after the period). */
  graceEndsAt: string | null;
};

export type CancelConfirmationEmail = {
  subject: string;
  text: string;
};

export function buildCancelConfirmationEmail(
  input: CancelConfirmationInput
): CancelConfirmationEmail {
  const effective = fmtDate(input.effectiveAt);
  const graceEnds = input.graceEndsAt ? fmtDate(input.graceEndsAt) : null;

  if (input.reason === "user_period_end") {
    return {
      subject: "Your NewCoworker subscription is scheduled to end",
      text: [
        "Your cancellation is scheduled.",
        `Your NewCoworker subscription will end on ${effective}.`,
        "You can undo this anytime before then from your billing dashboard.",
        "After the end date, your workspace enters a 30-day data-retention window during which you can reactivate without losing any data.",
        "— The NewCoworker Team"
      ].join("\n\n")
    };
  }

  if (input.reason === "payment_failed") {
    return {
      subject: "Your NewCoworker subscription has been paused",
      text: [
        "We couldn't process your last payment, so your subscription has been canceled.",
        `Your data is preserved until ${graceEnds ?? "30 days from now"} so you don't lose anything while you sort things out.`,
        "Reactivate anytime from your billing dashboard to restore access — we'll run a fresh checkout and bring your workspace back online within a few minutes.",
        "— The NewCoworker Team"
      ].join("\n\n")
    };
  }

  if (input.reason === "upgrade_switch") {
    return {
      subject: "Your NewCoworker plan change is in progress",
      text: [
        "Your previous NewCoworker plan has been canceled as part of your plan change.",
        "We're migrating your workspace to a fresh server on the new plan — this typically takes a few minutes.",
        "You'll get a separate confirmation when the new plan is fully live.",
        "— The NewCoworker Team"
      ].join("\n\n")
    };
  }

  const leadIn =
    input.reason === "admin_force"
      ? "A NewCoworker administrator canceled your subscription."
      : "Your subscription has been canceled at your request.";
  if (input.reason === "admin_force") {
    return {
      subject: "Your NewCoworker account has been closed",
      text: [
        leadIn,
        "Your workspace access has been disabled and account data has been scheduled for immediate wipe.",
        "Contact support if you believe this was a mistake.",
        "— The NewCoworker Team"
      ].join("\n\n")
    };
  }

  return {
    subject: "Your NewCoworker subscription has been canceled",
    text: [
      leadIn,
      `Your data is preserved until ${graceEnds ?? "30 days from now"}.`,
      "Reactivate anytime from your billing dashboard to restore access before the data-retention window closes.",
      "— The NewCoworker Team"
    ].join("\n\n")
  };
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    /* c8 ignore next -- Intl date formatting does not throw for invalid ISO strings in supported runtimes. */
  } catch {
    return iso;
  }
}
