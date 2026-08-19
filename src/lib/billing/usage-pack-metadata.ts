/**
 * Strict parsers for usage-pack amounts stamped on Stripe Checkout metadata.
 * Shared by the standalone Billing top-up path and membership pack add-ons.
 */

/**
 * Strict voice-seconds parser for Stripe metadata. Only accepts positive integer strings,
 * enforces an upper bound (~one year of call minutes), and refuses scientific notation,
 * floats, and leading-zero/negative/hex strings, all of which `Number.parseInt` silently
 * truncates or mis-parses, and which would otherwise mint a bogus bonus grant.
 */
/**
 * Hard per-unit ceilings, shared with the recurring membership decoder
 * (membership-pack-addons.ts) so the two parsers cannot drift: a forged or
 * corrupt metadata value must never mint an unbounded cap raise on EITHER
 * path. Values sit far above the largest catalog pack.
 */
export const HARD_MAX_PACK_UNIT = {
  /** One year of seconds. */
  voiceSeconds: 60 * 60 * 24 * 365,
  smsTexts: 1_000_000,
  chatMicros: 1_000_000_000
} as const;

export function parseVoiceBonusSecondsFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 9) return null;
  const n = Number(str);
  // Digit-only strings are always finite integers; keep the guard for
  // defense-in-depth against future parser changes.
  /* c8 ignore next 2 */
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  if (n > HARD_MAX_PACK_UNIT.voiceSeconds) return null;
  return n;
}

/**
 * Bonus outbound texts from an SMS pack checkout. Same hardening contract as
 * `parseVoiceBonusSecondsFromMetadata`: digits only, hard upper bound (1M
 * texts ≫ the largest catalog pack), reject floats/scientific/hex.
 */
export function parseSmsBonusTextsFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 7) return null;
  const n = Number(str);
  /* c8 ignore next 2 */
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  if (n > HARD_MAX_PACK_UNIT.smsTexts) return null;
  return n;
}

/**
 * Chat spend credit (micro-USD) from a Gemini pack checkout. Hard cap $1,000
 * of credit per checkout, far above the catalog, so a forged/corrupt
 * metadata value can never mint an unbounded cap raise.
 */
export function parseChatCreditMicrosFromMetadata(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return null;
  if (str.length > 10) return null;
  const n = Number(str);
  /* c8 ignore next 2 */
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0) return null;
  if (n > HARD_MAX_PACK_UNIT.chatMicros) return null;
  return n;
}
