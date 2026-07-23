/**
 * Transactional email: post-onboarding email verification.
 *
 * Sent once from `/api/onboard/set-password` immediately after the
 * Supabase auth user is minted, and again on demand from the dashboard
 * "Resend email" button (`/api/email/send-verification`).
 *
 * The `verificationUrl` is the only varying input; it's a fully-qualified
 * https://newcoworker.com/verify-email?token=... pointing at the route
 * that flips `customer_profiles.email_verified_at`. Don't dynamic-import
 * the token utility here, building the URL is the caller's job, so this
 * stays free of env dependencies and stays unit-testable without
 * supabase/Resend mocks.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale } from "@/lib/i18n/email-copy";

export type EmailVerificationMessageInput = {
  verificationUrl: string;
  siteUrl: string;
  recipientEmail: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export type EmailVerificationMessage = {
  subject: string;
  text: string;
  html: string;
};

export function buildEmailVerificationMessage(
  input: EmailVerificationMessageInput
): EmailVerificationMessage {
  const copy = emailMessagesForLocale(input.locale ?? defaultLocale);
  const c = copy.emailVerification;
  const subject = c.subject;
  const text = [
    c.welcome,
    c.textIntro,
    input.verificationUrl,
    c.textExpiry,
    copy.ncSignoff
  ].join("\n\n");

  const siteUrl = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: [
      { kind: "text", text: c.welcome },
      // Catalog-authored markup (bold brand name); not user input.
      { kind: "html", html: c.htmlIntro }
    ],
    cta: { label: c.cta, href: input.verificationUrl },
    fallbackHref: input.verificationUrl,
    warningLine: c.warningLine,
    securityNote: c.securityNote,
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
