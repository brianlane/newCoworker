/**
 * Transactional email: refund-issued.
 *
 * Sent by the lifecycle executor after a successful
 * `refund_latest_charge` Stripe op (cancelWithRefund + adminForceRefund).
 * Keeps the tenant in the loop while Stripe walks the refund back to the
 * original payment method.
 *
 * Plain-text on purpose; Resend handles MIME + headers.
 */

export type RefundIssuedInput = {
  amountCents: number;
};

export type RefundIssuedEmail = {
  subject: string;
  text: string;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function buildRefundIssuedEmail(input: RefundIssuedInput): RefundIssuedEmail {
  const amount = currency.format(Math.max(0, input.amountCents) / 100);
  return {
    subject: "Your NewCoworker refund is on its way",
    text: [
      `We've issued a refund of ${amount} to your original payment method.`,
      "Refunds typically show up in 5–10 business days depending on your bank.",
      "Your workspace has been scheduled for shutdown and we've saved a backup of your data for 30 days in case you decide to come back.",
      "If you have any questions, just reply to this email.",
      "— The NewCoworker Team"
    ].join("\n\n")
  };
}
