/**
 * Operator email: a tenant subscription invoice payment failed.
 *
 * Signup, cancel, and VPS-deletion already page ops. A card decline that
 * auto-cancels the Stripe subscription (Scar Fairy, Sep 16 2026) did not,
 * so ops only found out from the Stripe dashboard. This fires on
 * `invoice.payment_failed` for a linked membership row.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";

export type OpsPaymentFailedInput = {
  businessId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string;
  tier: string;
  invoiceId: string;
  stripeSubscriptionId: string | null;
  failureDetail: string;
  dbStatus: string;
  /** True when we will dispatch autoCancelOnPaymentFailure after this mail. */
  willAutoCancel: boolean;
  siteUrl: string;
};

export type OpsPaymentFailedEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildOpsPaymentFailedEmail(input: OpsPaymentFailedInput): OpsPaymentFailedEmail {
  const who = input.ownerName?.trim() ? input.ownerName.trim() : input.ownerEmail;
  const business = input.businessName.trim() || "(unnamed)";
  const subject = `[ops] Payment failed, ${business} (${input.tier})`;
  const textLines = [
    `A subscription invoice payment failed for ${business}.`,
    [
      `Business: ${business}`,
      `Business id: ${input.businessId}`,
      `Owner: ${who}`,
      `Owner email: ${input.ownerEmail}`,
      `Tier: ${input.tier}`,
      `DB status: ${input.dbStatus}`,
      `Invoice: ${input.invoiceId}`,
      `Stripe subscription: ${input.stripeSubscriptionId ?? "(none)"}`,
      `Failure: ${input.failureDetail}`,
      input.willAutoCancel
        ? "Next: autoCancelOnPaymentFailure will cancel the Stripe subscription and stamp cancel_reason=payment_failed."
        : "Next: row is not active, so auto-cancel was not dispatched."
    ].join("\n")
  ];
  const text = textLines.join("\n\n");
  const html = buildBrandedEmailHtml({
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Payment failed",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: {
      label: "Open admin panel",
      href: `${input.siteUrl}/admin/${input.businessId}`
    },
    recipientEmail: opsNotificationEmail()
  });
  return { subject, text, html };
}
