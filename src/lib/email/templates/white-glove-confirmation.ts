/**
 * Transactional email: white-glove purchase confirmation (Phase C5).
 *
 * Sent by the Stripe webhook after `checkout.session.completed` records a
 * white-glove package purchase. Tells the owner what they bought, that their
 * priority call/video line is open, and how to book the onboarding session
 * (calendar link when `WHITE_GLOVE_BOOKING_URL` is configured, otherwise
 * "reply to this email").
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";

export type WhiteGloveConfirmationInput = {
  packageName: string;
  recipientEmail: string;
  /** End of the priority call/video support window. */
  prioritySupportUntil: Date;
  /** Scheduling link; null → "reply to this email" fallback copy. */
  bookingUrl: string | null;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
};

export type WhiteGloveConfirmationEmail = {
  subject: string;
  text: string;
  html: string;
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
});

export function buildWhiteGloveConfirmationEmail(
  input: WhiteGloveConfirmationInput
): WhiteGloveConfirmationEmail {
  const subject = `Your ${input.packageName} is confirmed`;
  const untilDate = dateFormat.format(input.prioritySupportUntil);
  const bookingLine = input.bookingUrl
    ? `Book your onboarding session here: ${input.bookingUrl}`
    : "Reply to this email and we'll schedule your onboarding session.";
  const textLines = [
    `Thanks for purchasing ${input.packageName} — a specialist will work with you one-on-one to get your AI coworker fully dialed in.`,
    bookingLine,
    `Your priority call & video support line is open through ${untilDate}.`,
    "— The NewCoworker Team"
  ];
  const text = textLines.join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: input.bookingUrl
      ? { label: "Book your session", href: input.bookingUrl }
      : { label: "Open dashboard", href: `${normalizedSite}/dashboard` },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
