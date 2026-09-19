/**
 * Transactional email: a subscription invoice payment was declined.
 *
 * Sent from the Stripe `invoice.payment_failed` webhook as soon as we
 * see an active (or in-grace) membership invoice fail, independently of
 * the later auto-cancel confirmation. Keep this file input-pure.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailDate, emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type PaymentDeclinedInput = {
  recipientEmail: string;
  siteUrl: string;
  /** Human summary of what failed, e.g. "Amex ending 3042, declined (do_not_honor)". */
  failureDetail: string;
  /** ISO grace deadline when known. */
  graceEndsAt?: string | null;
  timeZone?: string;
  locale?: AppLocale;
};

export type PaymentDeclinedEmail = {
  subject: string;
  text: string;
  html: string;
};

export function buildPaymentDeclinedEmail(input: PaymentDeclinedInput): PaymentDeclinedEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale);
  const c = copy.paymentDeclined;
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const billingUrl = `${normalizedSite}/dashboard/billing`;
  const graceEnds = input.graceEndsAt
    ? emailDate(new Date(input.graceEndsAt), locale, input.timeZone)
    : null;
  const textLines = [
    c.lead,
    fmtEmail(c.whatFailed, { detail: input.failureDetail }),
    graceEnds ? fmtEmail(c.grace, { date: graceEnds }) : c.graceGeneric,
    c.next
  ];
  const text = [...textLines, copy.ncSignoff].join("\n\n");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: c.subject,
    heading: c.subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: copy.openBilling, href: billingUrl },
    includeFallbackLink: true,
    recipientEmail: input.recipientEmail
  });
  return { subject: c.subject, text, html };
}
