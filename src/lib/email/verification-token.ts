import { createHmac, timingSafeEqual } from "crypto";

/**
 * HMAC-signed, opaque-string email verification token.
 *
 * Why a self-contained token rather than a DB-row token
 * --------------------------------------------------------
 * We deliberately do NOT persist tokens in a `email_verifications` table.
 * The verify-email landing page handles the click idempotently against
 * `customer_profiles.email_verified_at`: the first valid click stamps the
 * column; subsequent clicks (replays from the same email, browser back
 * button, etc.) read the existing timestamp and short-circuit. Storing
 * tokens in the DB would force us to also implement a token-cleanup cron
 * and harden against replay races, both for zero gain over an HMAC the
 * route can verify in O(1) without any read.
 *
 * The 7-day TTL gives users a comfortable window to click the link from
 * a separate device/inbox without being too long-lived to be useful as a
 * stolen credential. The dashboard "Resend email" button re-mints a
 * fresh token each time, so a forgotten/expired link is never a hard
 * dead-end.
 *
 * Secret resolution mirrors `src/lib/onboarding/token.ts`:
 * `EMAIL_VERIFICATION_TOKEN_SECRET` if set, else `SUPABASE_SERVICE_ROLE_KEY`
 * as a fallback so single-tenant deployments don't have to plumb a new
 * env var. Production multi-tenant deploys SHOULD set the dedicated
 * secret so rotating the service-role key doesn't silently invalidate
 * every outstanding verification email.
 */

const VERIFICATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type VerificationTokenPayload = {
  email: string;
  issuedAt: number;
};

function getVerificationTokenSecret(): string {
  const secret =
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("EMAIL_VERIFICATION_TOKEN_SECRET is not configured");
  }
  return secret;
}

function encodePayload(payload: VerificationTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", getVerificationTokenSecret())
    .update(encodedPayload)
    .digest("base64url");
}

export function createEmailVerificationToken(email: string, now: number = Date.now()): string {
  const payload: VerificationTokenPayload = {
    email: email.trim().toLowerCase(),
    issuedAt: now
  };
  const encoded = encodePayload(payload);
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

export type VerificationTokenResult =
  | { ok: true; email: string; issuedAt: number }
  | { ok: false; reason: "malformed" | "signature_mismatch" | "expired" | "decode_error" };

export function verifyEmailVerificationToken(
  token: string,
  now: number = Date.now()
): VerificationTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return { ok: false, reason: "malformed" };

  const expectedSignature = signPayload(encodedPayload);
  const sigBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  const sigMatches =
    sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  if (!sigMatches) return { ok: false, reason: "signature_mismatch" };

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as VerificationTokenPayload;
    if (typeof payload.email !== "string" || !payload.email) {
      return { ok: false, reason: "decode_error" };
    }
    if (typeof payload.issuedAt !== "number" || !Number.isFinite(payload.issuedAt)) {
      return { ok: false, reason: "decode_error" };
    }
    if (now - payload.issuedAt > VERIFICATION_TOKEN_TTL_MS) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, email: payload.email, issuedAt: payload.issuedAt };
  } catch {
    return { ok: false, reason: "decode_error" };
  }
}
