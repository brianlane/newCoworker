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
 * the token utility here — building the URL is the caller's job, so this
 * stays free of env dependencies and stays unit-testable without
 * supabase/Resend mocks.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";

export type EmailVerificationMessageInput = {
  verificationUrl: string;
  siteUrl: string;
  recipientEmail: string;
};

export type EmailVerificationMessage = {
  subject: string;
  text: string;
  html: string;
};

export function buildEmailVerificationMessage(
  input: EmailVerificationMessageInput
): EmailVerificationMessage {
  const subject = "Confirm your NewCoworker email";
  const text = [
    "Welcome to NewCoworker!",
    "To finish securing your account, please confirm your email address by opening the link below:",
    input.verificationUrl,
    "This link expires in 7 days. If you didn't create a NewCoworker account, you can safely ignore this email.",
    "— The NewCoworker Team"
  ].join("\n\n");

  const siteUrl = input.siteUrl.replace(/\/$/, "");
  const html = buildBrandedEmailHtml({
    siteUrl,
    documentTitle: subject,
    heading: subject,
    bodyBlocks: [
      { kind: "text", text: "Welcome to NewCoworker!" },
      {
        kind: "html",
        html: `Here's your link to confirm your email for <strong style="color:#1BD96A;">New Coworker</strong>. Click the button below — no password needed.`
      }
    ],
    cta: { label: "Confirm email", href: input.verificationUrl },
    fallbackHref: input.verificationUrl,
    warningLine: "This link expires in 7 days.",
    securityNote:
      "If you didn't create a NewCoworker account, you can safely ignore this email. Your account is secure.",
    recipientEmail: input.recipientEmail
  });

  return { subject, text, html };
}
