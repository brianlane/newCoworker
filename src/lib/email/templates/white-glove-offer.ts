/**
 * Transactional email: a CUSTOM white-glove offer's payment invitation.
 *
 * Sent by the admin "Create offer" action (POST /api/admin/white-glove-offers)
 * to the offer's recipient, a prospect with no account yet, or an existing
 * owner. Carries the deal name, the admin-written description, the price,
 * and the durable /offer/<pay_token> payment link (which mints a fresh
 * Stripe Checkout session per visit, so the link never expires).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type WhiteGloveOfferEmailInput = {
  offerName: string;
  /** Admin-written description; "" renders no description line. */
  description: string;
  amountCents: number;
  /** The durable public payment link (/offer/<pay_token>). */
  payUrl: string;
  recipientEmail: string;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type WhiteGloveOfferEmail = {
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

export function buildWhiteGloveOfferEmail(
  input: WhiteGloveOfferEmailInput
): WhiteGloveOfferEmail {
  const copy = emailMessagesForLocale(input.locale ?? defaultLocale);
  const c = copy.whiteGloveOffer;
  const subject = fmtEmail(c.subject, { offerName: input.offerName });
  const price = currency.format(input.amountCents / 100);
  const textLines = [
    fmtEmail(c.line1, { offerName: input.offerName, price }),
    ...(input.description.trim() ? [input.description.trim()] : []),
    fmtEmail(c.payLine, { payUrl: input.payUrl }),
    c.afterPay,
    copy.questionsReply
  ];
  // Signoff rides only the plain-text body, the HTML shell renders the full
  // platform signature block, so repeating it there would double the contact info.
  const text = [...textLines, copy.ncSignoff].join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: fmtEmail(c.cta, { price }), href: input.payUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
