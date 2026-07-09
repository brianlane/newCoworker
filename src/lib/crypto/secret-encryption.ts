/**
 * App-layer encryption for secrets stored in Postgres (security review G5).
 *
 * Supabase's platform encryption-at-rest protects the disk, not the rows: a
 * leaked service-role key or DB dump exposes plaintext columns. This module
 * adds an application envelope so `vps_ssh_keys.private_key_pem` and
 * `residency_backup_keys.passphrase` are AES-256-GCM ciphertext at rest.
 * (Per-tenant gateway tokens stay plaintext BY DESIGN — the same value is
 * the symmetric HMAC secret on the tenant box, see README §per-tenant
 * gateway tokens.)
 *
 * Design:
 *   - Master key: `SECRETS_ENCRYPTION_KEY` env — 32 bytes, base64url
 *     (`openssl rand 32 | basenc --base64url` or the helper in
 *     debug/encrypt-secrets-backfill.ts). Present in Vercel + repo `.env`
 *     (debug/redeploy tooling reads the same secrets there).
 *   - Wire format: `enc:v1:<iv>:<tag>:<ciphertext>` with base64url parts.
 *     The prefix makes legacy plaintext rows distinguishable, enabling the
 *     same lazy read-path migration pattern the SSH-key PEM re-framing
 *     already uses; debug/encrypt-secrets-backfill.ts converts the stock.
 *   - Fail-closed reads: an encrypted row without the key (or with the
 *     wrong key) throws loudly. Nothing downstream can use a garbled
 *     secret anyway — SSH would USERAUTH_FAIL and backups would encrypt
 *     with the wrong passphrase, which are far worse failure modes.
 *   - Graceful rollout: when the env key is ABSENT, writes stay plaintext
 *     and plaintext reads pass through, so deploys sequence safely
 *     (code first, key + backfill second).
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

/** True when `value` carries this module's ciphertext envelope. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

function loadKey(env: Record<string, string | undefined>): Buffer | null {
  const raw = env.SECRETS_ENCRYPTION_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // Buffer.from(..., "base64url") never throws for string input — invalid
  // characters are skipped — so the 32-byte length check below is also the
  // malformed-key check (a garbage value decodes to the wrong length).
  const key = Buffer.from(raw.trim(), "base64url");
  if (key.length !== KEY_BYTES) {
    throw new SecretEncryptionError(
      `SECRETS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

/**
 * Encrypt a secret for storage. Pass-through (plaintext) when the master
 * key is not configured — rollout ordering: ship code, then set the key,
 * then backfill. Encrypting an already-encrypted value is a no-op so
 * upsert paths can't double-wrap.
 */
export function encryptSecret(
  plaintext: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (isEncryptedSecret(plaintext)) return plaintext;
  const key = loadKey(env);
  if (key === null) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * Decrypt a stored secret. Plaintext (legacy) values pass through
 * unchanged; encrypted values REQUIRE the key and a valid GCM tag —
 * anything else throws {@link SecretEncryptionError} (fail closed).
 */
export function decryptSecret(
  stored: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (!isEncryptedSecret(stored)) return stored;
  const key = loadKey(env);
  if (key === null) {
    throw new SecretEncryptionError(
      "Encountered an encrypted secret but SECRETS_ENCRYPTION_KEY is not set — " +
        "configure the key in the environment (.env for tooling, Vercel for the app)"
    );
  }
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new SecretEncryptionError("Malformed encrypted secret (expected enc:v1:<iv>:<tag>:<ct>)");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== IV_BYTES) {
    throw new SecretEncryptionError("Malformed encrypted secret (bad IV length)");
  }
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretEncryptionError(
      "Failed to decrypt stored secret — wrong SECRETS_ENCRYPTION_KEY or corrupted ciphertext"
    );
  }
}

/**
 * Constant-time equality for two secret strings (used by tests and any
 * future fingerprint comparisons; exported so callers never hand-roll
 * `===` on secret material).
 */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
