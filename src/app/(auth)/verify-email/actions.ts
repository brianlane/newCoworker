"use server";

import { markEmailVerifiedByEmail } from "@/lib/db/customer-profiles";
import { verifyEmailVerificationToken } from "@/lib/email/verification-token";
import { logger } from "@/lib/logger";

/**
 * Possible outcomes of the explicit "Confirm your email" form submission.
 *
 * Kept narrow on purpose: the page only renders five distinct screens
 * (success, already-verified, expired link, invalid link, not_found,
 * internal). The discriminator is the union; the `alreadyVerified` flag
 * on the success branch lets the UI reuse one render path for both
 * first-confirmation and idempotent-replay cases.
 */
export type ConfirmEmailVerificationResult =
  | { kind: "ok"; alreadyVerified: boolean }
  | {
      kind: "error";
      reason: "missing_token" | "invalid" | "expired" | "not_found" | "internal";
    };

/**
 * Server action that flips `customer_profiles.email_verified_at`.
 *
 * IMPORTANT: this must NEVER be called from a GET handler. It is the
 * single state-mutating site for email verification, gated behind an
 * explicit form POST so mailbox safe-link scanners (Microsoft Safe
 * Links, Mimecast, Proofpoint, Gmail's TLS inspector, etc.) — which
 * routinely auto-fetch URLs from inbound emails over GET — can NEVER
 * silently consume the verification on the human's behalf. An earlier
 * revision of `/verify-email/page.tsx` did the DB flip in the GET path
 * itself; that implementation is what this server action replaces.
 *
 * Same-origin protection: Next.js 15 server actions enforce an Origin/
 * Host header equality check at the framework level, so a forged form
 * submitted from another site can't trigger this action even with a
 * valid HMAC token in the body. The token is the credential against
 * which we authenticate the verify; the framework's same-origin check
 * is the credential against which we authenticate the form submission.
 */
export async function confirmEmailVerificationAction(
  _prev: ConfirmEmailVerificationResult | null,
  formData: FormData
): Promise<ConfirmEmailVerificationResult> {
  const raw = formData.get("token");
  if (typeof raw !== "string" || !raw) {
    return { kind: "error", reason: "missing_token" };
  }

  const verified = verifyEmailVerificationToken(raw);
  if (!verified.ok) {
    return {
      kind: "error",
      reason: verified.reason === "expired" ? "expired" : "invalid"
    };
  }

  try {
    const result = await markEmailVerifiedByEmail(verified.email);
    if (!result.ok) {
      logger.warn("verify-email: customer_profile not found for token email", {
        // Email is the only thing carried by a token submitted through
        // this action — no userId, no businessId. Logging the email at
        // warn-level is fine: this branch is essentially unreachable in
        // production (`upsertCustomerProfile` runs on /api/checkout
        // before Stripe), so when it fires it's an investigation signal
        // rather than a routine event.
        email: verified.email
      });
      return { kind: "error", reason: "not_found" };
    }
    return { kind: "ok", alreadyVerified: result.alreadyVerified };
  } catch (err) {
    logger.error("verify-email: markEmailVerifiedByEmail threw", {
      email: verified.email,
      error: err instanceof Error ? err.message : String(err)
    });
    return { kind: "error", reason: "internal" };
  }
}
