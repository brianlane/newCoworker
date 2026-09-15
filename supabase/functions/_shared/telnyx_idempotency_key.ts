/**
 * Telnyx `Idempotency-Key` header encoding.
 *
 * Telnyx OpenAPI (`IdempotencyKey`) and the Email/Messaging docs: the header
 * is optional, 1 to 255 letters / numbers / hyphens / underscores. Empty,
 * duplicated, malformed, or overlong values return HTTP 400 with code
 * 10015 and pointer `/header/Idempotency-Key`.
 *
 * AiFlow (and several other senders) historically used colon-separated
 * logical keys (`aiflow:${runId}:${step}`). Colons (and `+` in E.164
 * offer keys) are not in the allowed charset. On 2026-09-15 that started
 * failing across Amy / KYP / KIN while inbound UUID keys still delivered.
 *
 * Rewrite at the HTTP boundary so every caller keeps a stable logical key
 * across retries of the same send, and Telnyx always sees a valid header.
 */

/** Telnyx max length for `Idempotency-Key`. */
export const TELNYX_IDEMPOTENCY_KEY_MAX = 255;

/** Allowed charset after encoding: letters, numbers, hyphen, underscore. */
export const TELNYX_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Encode a caller logical key into a Telnyx-accepted `Idempotency-Key`.
 * Empty / whitespace-only input omits the header (returns undefined).
 * The mapping is deterministic: retries of the same logical send reuse
 * the same encoded value.
 */
export function toTelnyxIdempotencyKey(
  raw: string | null | undefined
): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, TELNYX_IDEMPOTENCY_KEY_MAX);
}
