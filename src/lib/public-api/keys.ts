/**
 * API-key credential format for the public REST API (/api/public/v1/*).
 *
 * Keys look like `nck_<64 hex chars>` (256 bits of entropy). Only the
 * SHA-256 hash is persisted (api_keys.key_hash); the plaintext exists
 * exactly once, in the mint response the owner copies into Zapier. The
 * first 12 characters are stored as `key_prefix` purely so the dashboard
 * can render "nck_a1b2c3d4…" for identification.
 */

import { createHash, randomBytes } from "crypto";

export const API_KEY_PREFIX = "nck_";
const API_KEY_RANDOM_BYTES = 32;
const KEY_PREFIX_DISPLAY_CHARS = 12;

export const API_KEY_REGEX = /^nck_[0-9a-f]{64}$/;

export type MintedApiKey = {
  /** The full plaintext credential — shown once, never stored. */
  plaintext: string;
  /** SHA-256 hex of the plaintext; the only thing the DB keeps. */
  hash: string;
  /** Display prefix, e.g. "nck_a1b2c3d4". */
  prefix: string;
};

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function mintApiKey(): MintedApiKey {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString("hex")}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, KEY_PREFIX_DISPLAY_CHARS)
  };
}

/**
 * Extract a syntactically valid API key from an Authorization header.
 * Returns null for anything else — the caller answers 401 without a DB
 * round-trip for garbage tokens.
 */
export function apiKeyFromAuthorizationHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1];
  return API_KEY_REGEX.test(token) ? token : null;
}
