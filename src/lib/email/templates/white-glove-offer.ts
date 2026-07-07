/**
 * Transactional email: a CUSTOM white-glove offer's payment invitation.
 *
 * Sent by the admin "Create offer" action (POST /api/admin/white-glove-offers)
 * to the offer's recipient — a prospect with no account yet, or an existing
 * owner. Carries the deal name, the admin-written description, the price,
 * and the durable /offer/<pay_token> payment link (which mints a fresh
 * Stripe Checkout session per visit, so the link never expires).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";

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
  const subject = `Your NewCoworker offer: ${input.offerName}`;
  const price = currency.format(input.amountCents / 100);
  const textLines = [
    `We've prepared a custom white-glove offer for you: ${input.offerName} — ${price}, one-time.`,
    ...(input.description.trim() ? [input.description.trim()] : []),
    `Pay securely through Stripe here: ${input.payUrl}`,
    "After payment you'll get an email confirmation and a booking link, and everything follows your account automatically.",
    "Questions? Just reply to this email.",
    "— The NewCoworker Team"
  ];
  const text = textLines.join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: `Pay ${price} securely`, href: input.payUrl },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
