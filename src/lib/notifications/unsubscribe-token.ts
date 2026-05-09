/**
 * One-click email-link unsubscribe tokens.
 *
 * Tokens are HMAC-SHA256 of `${version}.${businessId}.${issuedAtSec}` with the
 * secret in `NOTIFICATIONS_UNSUBSCRIBE_SECRET`, encoded as base64url and
 * concatenated with the payload so verification is self-contained (no DB
 * lookup). This is the same shape Resend/Mailchimp/etc. use for
 * RFC 8058 List-Unsubscribe-Post links.
 *
 * TTL is intentionally generous (default 90 days). Gmail / Apple Mail will
 * keep using whatever token was in the most-recent message they have, and
 * users sometimes click an unsubscribe months later. A short TTL just makes
 * those clicks fail and trains users to ignore the link.
 *
 * Constant-time compare on the HMAC; tampered or expired tokens never reach
 * the DB layer.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_SEC = 60 * 60 * 24 * 90;

export type UnsubscribeTokenPayload = {
  businessId: string;
  issuedAtSec: number;
};

export type SignOptions = {
  /** Override the issue time (mostly for tests). Defaults to now. */
  nowSec?: number;
};

export type VerifyOptions = {
  /** TTL in seconds. Defaults to 90 days. */
  ttlSec?: number;
  /** Override the verification clock (mostly for tests). Defaults to now. */
  nowSec?: number;
};

export type VerifyResult =
  | { ok: true; payload: UnsubscribeTokenPayload }
  | { ok: false; reason: "missing_secret" | "malformed" | "bad_signature" | "expired" };

function secretFromEnv(): string {
  return (process.env.NOTIFICATIONS_UNSUBSCRIBE_SECRET ?? "").trim();
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer | null {
  // Reject anything that isn't strict base64url to keep the surface tight.
  // (`verifyUnsubscribeToken` already guarantees a non-empty input via the
  // four-part split + per-part truthiness check, so we don't re-check here.)
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  // Pad to a multiple of 4 for Buffer.from('base64').
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input + "=".repeat(padLen);
  const buf = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf;
}

function hmacBytes(secret: string, message: string): Buffer {
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

/**
 * Sign an unsubscribe token. Returns null if the secret is unset (callers
 * should treat that as "feature disabled" rather than an error so a missing
 * env var doesn't crash an outbound email).
 */
export function signUnsubscribeToken(
  businessId: string,
  options: SignOptions = {}
): string | null {
  const secret = secretFromEnv();
  if (!secret) return null;
  if (!businessId) return null;

  const issuedAtSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const payload = `${TOKEN_VERSION}.${businessId}.${issuedAtSec}`;
  const sig = base64UrlEncode(hmacBytes(secret, payload));
  return `${payload}.${sig}`;
}

/**
 * Verify a token. Returns the parsed payload on success. Never throws.
 *
 * Why constant-time compare matters here: without it, the unsubscribe
 * endpoint's failure mode would leak how many leading bytes of a forged
 * signature matched, and an attacker who can submit thousands of guesses
 * could grind out a valid token byte-by-byte. We pay the constant-time
 * cost even though the endpoint is rate-limited at the platform layer.
 */
export function verifyUnsubscribeToken(
  token: string,
  options: VerifyOptions = {}
): VerifyResult {
  const secret = secretFromEnv();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, businessId, issuedAtRaw, providedSig] = parts;
  if (version !== TOKEN_VERSION || !businessId || !issuedAtRaw || !providedSig) {
    return { ok: false, reason: "malformed" };
  }

  const issuedAtSec = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAtSec) || issuedAtSec <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const expected = hmacBytes(secret, `${version}.${businessId}.${issuedAtSec}`);
  const provided = base64UrlDecode(providedSig);
  if (!provided) return { ok: false, reason: "malformed" };
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  let signatureOk = false;
  try {
    signatureOk = timingSafeEqual(provided, expected);
  } catch {
    /* v8 ignore next 2 -- both buffers are equal-length sha-256 digests; node's
       timingSafeEqual only throws on length mismatch, which we've already filtered. */
    return { ok: false, reason: "bad_signature" };
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  const ttl = options.ttlSec ?? DEFAULT_TTL_SEC;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (nowSec - issuedAtSec > ttl) return { ok: false, reason: "expired" };
  // Allow a bit of clock skew on the past-side. A token issued five minutes in
  // the future (sender clock drifted) still verifies; ten years in the future
  // does not.
  if (issuedAtSec - nowSec > 60 * 60) return { ok: false, reason: "malformed" };

  return { ok: true, payload: { businessId, issuedAtSec } };
}

/**
 * Build the public unsubscribe URL for a given business. Returns null if no
 * token can be minted (secret unset). Used by the email senders so the same
 * URL appears in the body and the `List-Unsubscribe` header.
 */
export function buildUnsubscribeUrl(
  businessId: string,
  appUrl: string | undefined,
  options: SignOptions = {}
): string | null {
  const token = signUnsubscribeToken(businessId, options);
  if (!token) return null;
  const base = (appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://www.newcoworker.com").replace(
    /\/$/,
    ""
  );
  return `${base}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}
