import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildEmailVerificationMessage } from "@/lib/email/templates/email-verification";
import { createEmailVerificationToken } from "@/lib/email/verification-token";
import { logger } from "@/lib/logger";

/**
 * POST /api/email/send-verification
 *
 * Auth-required. Mints a fresh HMAC-signed verification token for the
 * caller's account email and sends the verification email via Resend.
 *
 * Used by the dashboard's `UnverifiedEmailBanner` "Resend email" button.
 * The first verification email is sent inline from
 * `/api/onboard/set-password` immediately after user mint, so this
 * endpoint is purely for resends — it does NOT need to be reachable
 * unauthenticated.
 *
 * Why we don't take an `email` body parameter
 * --------------------------------------------
 * If the request body could specify an arbitrary email, an authenticated
 * attacker could grind verification emails at any victim address (free
 * spam, plus a successful click would silently flip our `email_verified_at`
 * for THEIR `customer_profiles` row — which is fine in itself, but the
 * UX assumes the verification reflects the signed-in user). Pinning to
 * `user.email` server-side closes both surfaces and matches the
 * onboarding flow where the email is provably the one Stripe billed.
 */
export async function POST() {
  try {
    const user = await requireAuth();
    if (!user.email) {
      return errorResponse("VALIDATION_ERROR", "Account has no email address");
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const siteUrl = baseUrl.replace(/\/$/, "");
    const token = createEmailVerificationToken(user.email);
    const verificationUrl = `${siteUrl}/verify-email?token=${encodeURIComponent(token)}`;
    const { subject, text, html } = buildEmailVerificationMessage({
      verificationUrl,
      siteUrl,
      recipientEmail: user.email
    });

    try {
      await sendOwnerEmail(process.env.RESEND_API_KEY ?? "", user.email, subject, { text, html });
    } catch (err) {
      logger.error("send-verification: resend send failed", {
        userId: user.userId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not send verification email. Please retry later.",
        500
      );
    }

    logger.info("send-verification: verification email dispatched", {
      userId: user.userId
    });
    return successResponse({ sent: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
