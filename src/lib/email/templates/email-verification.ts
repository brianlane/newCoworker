/**
 * Transactional email: post-onboarding email verification.
 *
 * Sent once from `/api/onboard/set-password` immediately after the
 * Supabase auth user is minted, and again on demand from the dashboard
 * "Resend email" button (`/api/email/send-verification`). Plain-text by
 * design — `sendOwnerEmail` (Resend) handles deliverability headers, and
 * keeping the template deterministic + input-pure makes it trivially
 * snapshot-testable.
 *
 * The `verificationUrl` is the only varying input; it's a fully-qualified
 * https://newcoworker.com/verify-email?token=... pointing at the route
 * that flips `customer_profiles.email_verified_at`. Don't dynamic-import
 * the token utility here — building the URL is the caller's job, so this
 * stays free of env dependencies and stays unit-testable without
 * supabase/Resend mocks.
 */

export type EmailVerificationMessageInput = {
  verificationUrl: string;
};

export type EmailVerificationMessage = {
  subject: string;
  text: string;
};

export function buildEmailVerificationMessage(
  input: EmailVerificationMessageInput
): EmailVerificationMessage {
  return {
    subject: "Confirm your NewCoworker email",
    text: [
      "Welcome to NewCoworker!",
      "To finish securing your account, please confirm your email address by opening the link below:",
      input.verificationUrl,
      "This link expires in 7 days. If you didn't create a NewCoworker account, you can safely ignore this email.",
      "— The NewCoworker Team"
    ].join("\n\n")
  };
}
