/**
 * Credential formats for the embeddable website chat widget.
 *
 * Two distinct tokens, deliberately NOT the secret `nck_` public-API key
 * (src/lib/public-api/keys.ts):
 *
 *   * Widget site key `ncw_pub_<64 hex>` — identifies the tenant. PUBLIC by
 *     design: it ships inside the tenant's website HTML, so it is stored in
 *     plaintext (plus a sha256 lookup column) and grants nothing beyond
 *     "start a widget session for this business" — the restricted tool
 *     surface, origin allowlist, and rate limits are the real controls.
 *   * Session bearer `ncws_<64 hex>` — minted per visitor session, returned
 *     once by POST /api/widget/session, stored ONLY as a sha256 hash.
 *     Scopes every /api/widget/message + /api/widget/poll call to one
 *     session.
 */

import { createHash, randomBytes } from "crypto";

export const WIDGET_KEY_PREFIX = "ncw_pub_";
export const WIDGET_SESSION_TOKEN_PREFIX = "ncws_";
const RANDOM_BYTES = 32;

export const WIDGET_KEY_REGEX = /^ncw_pub_[0-9a-f]{64}$/;
export const WIDGET_SESSION_TOKEN_REGEX = /^ncws_[0-9a-f]{64}$/;

export function hashWebchatToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export type MintedWidgetKey = {
  /** Full site key — stored in plaintext (it is public by design). */
  plaintext: string;
  /** sha256 hex — the O(1) request-time lookup index. */
  hash: string;
};

export function mintWidgetKey(): MintedWidgetKey {
  const plaintext = `${WIDGET_KEY_PREFIX}${randomBytes(RANDOM_BYTES).toString("hex")}`;
  return { plaintext, hash: hashWebchatToken(plaintext) };
}

export type MintedSessionToken = {
  /** Full bearer — returned to the widget once, never stored. */
  plaintext: string;
  /** sha256 hex — the only thing persisted (webchat_sessions.session_token_sha256). */
  hash: string;
};

export function mintWebchatSessionToken(): MintedSessionToken {
  const plaintext = `${WIDGET_SESSION_TOKEN_PREFIX}${randomBytes(RANDOM_BYTES).toString("hex")}`;
  return { plaintext, hash: hashWebchatToken(plaintext) };
}

/**
 * Extract a syntactically valid widget site key from a request value
 * (query param or JSON field). Null for anything else so the route can
 * answer 401 without a DB round-trip on garbage.
 */
export function parseWidgetKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return WIDGET_KEY_REGEX.test(v) ? v : null;
}

/** Extract a syntactically valid session bearer from an Authorization header. */
export function sessionTokenFromAuthorizationHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  return WIDGET_SESSION_TOKEN_REGEX.test(token) ? token : null;
}
