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
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type WhiteGloveConfirmationInput = {
  packageName: string;
  recipientEmail: string;
  /** End of the priority call/video support window. */
  prioritySupportUntil: Date;
  /** Scheduling link; null → "reply to this email" fallback copy. */
  bookingUrl: string | null;
  /** App origin without trailing slash (e.g. https://www.newcoworker.com). */
  siteUrl: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type WhiteGloveConfirmationEmail = {
  subject: string;
  text: string;
  html: string;
};

function dateFormat(locale: AppLocale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

export function buildWhiteGloveConfirmationEmail(
  input: WhiteGloveConfirmationInput
): WhiteGloveConfirmationEmail {
  const locale = input.locale ?? defaultLocale;
  const copy = emailMessagesForLocale(locale);
  const c = copy.whiteGloveConfirmation;
  const subject = fmtEmail(c.subject, { packageName: input.packageName });
  const untilDate = dateFormat(locale).format(input.prioritySupportUntil);
  const bookingLine = input.bookingUrl
    ? fmtEmail(c.bookingLine, { bookingUrl: input.bookingUrl })
    : c.replyLine;
  const textLines = [
    fmtEmail(c.line1, { packageName: input.packageName }),
    bookingLine,
    fmtEmail(c.priorityLine, { date: untilDate })
  ];
  // Signoff rides only the plain-text body — the HTML shell renders the full
  // platform signature block, so repeating it there would double the contact info.
  const text = [...textLines, copy.ncSignoff].join("\n\n");
  const normalizedSite = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl: normalizedSite,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: input.bookingUrl
      ? { label: c.ctaBook, href: input.bookingUrl }
      : { label: copy.openDashboardCta, href: `${normalizedSite}/dashboard` },
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
