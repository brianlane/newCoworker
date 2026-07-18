/**
 * Transactional email: refund-issued.
 *
 * Sent by the lifecycle executor after a successful
 * `refund_latest_charge` Stripe op (cancelWithRefund + adminForceRefund).
 * Keeps the tenant in the loop while Stripe walks the refund back to the
 * original payment method.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type RefundIssuedInput = {
  amountCents: number;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type RefundIssuedEmail = {
  subject: string;
  text: string;
  html: string;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function buildRefundIssuedEmail(input: RefundIssuedInput): RefundIssuedEmail {
  const copy = emailMessagesForLocale(input.locale ?? defaultLocale);
  const amount = currency.format(Math.max(0, input.amountCents) / 100);
  const subject = copy.refundIssued.subject;
  const textLines = [
    fmtEmail(copy.refundIssued.line1, { amount }),
    copy.refundIssued.line2,
    copy.refundIssued.line3,
    copy.refundIssued.line4,
    copy.ncSignoff
  ];
  const text = textLines.join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: copy.openBilling, href: billingUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
