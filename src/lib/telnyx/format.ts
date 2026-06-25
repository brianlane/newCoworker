/**
 * Shared phone-number formatting helpers. Centralizes the NANP pretty-print
 * used by the tenant `PhoneNumberCard` and the admin `AssignDidPanel` so the
 * two UIs stay in sync if/when we extend formatting (e.g. other countries).
 *
 * Non-NANP / malformed input is returned as-is so callers never have to guard
 * — printing the raw E.164 is strictly better than throwing in the UI.
 */

const NANP_RE = /^\+1(\d{3})(\d{3})(\d{4})$/;

/**
 * Pretty-print a +1 NANP number as `(AAA) PPP-NNNN`. Returns the input
 * unchanged for anything that doesn't match (including `null`/empty strings,
 * which are coerced to the empty string).
 */
export function formatDid(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = NANP_RE.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Result of coercing free-text phone input into a canonical contact number.
 * `value` is either a real E.164 number (`+1305...`) or a bare 3-8 digit short
 * code; `reason` is a human-readable hint to show the owner when we refuse.
 */
export type NormalizedContactNumber =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// Structural E.164: `+`, a non-zero country-code digit, then 7-15 total digits.
const E164_RE = /^\+[1-9]\d{6,14}$/;
// Lead sources (ReferralExchange, realtor.com) text from 3-8 digit short codes.
const SHORT_CODE_RE = /^\d{3,8}$/;

/**
 * Coerce whatever a human typed into a canonical contact number, so the UI can
 * be forgiving about formatting while storage stays clean.
 *
 * Rules, in order:
 *  - An explicit country code (a leading `+` or international `00`) is trusted
 *    and only structurally validated as E.164. `"+44 20 7123 4567"` →
 *    `"+442071234567"`, `"0044 20 7123 4567"` → `"+442071234567"`.
 *  - With NO country code we assume the US/NANP: a 10-digit number gets `+1`
 *    and an 11-digit number starting with `1` gets `+`. So `"(305) 613-3412"`,
 *    `"305-613-3412"`, `"305.613.3412"`, and `"1 305 613 3412"` all become
 *    `"+13056133412"`.
 *  - A bare 3-8 digit value with no country code is a short code, returned
 *    digits-only.
 *
 * Punctuation, spaces, and parentheses are ignored throughout. Returns a
 * discriminated result rather than throwing so both client and server callers
 * can surface `reason` directly.
 */
export function normalizeContactNumber(
  raw: string | null | undefined
): NormalizedContactNumber {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a phone number or short code" };

  // A leading `+` or international `00` both mean the caller already supplied a
  // country code, so we must not also prepend `+1`.
  const hasCountryCode = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "Enter a valid phone number" };

  if (hasCountryCode) {
    const intl = trimmed.startsWith("00") ? digits.slice(2) : digits;
    const candidate = `+${intl}`;
    return E164_RE.test(candidate)
      ? { ok: true, value: candidate }
      : {
          ok: false,
          reason: "Enter a valid international number, e.g. +44 20 7123 4567"
        };
  }

  // No country code → assume North America for full-length numbers.
  if (digits.length === 10) return { ok: true, value: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) {
    return { ok: true, value: `+${digits}` };
  }

  if (SHORT_CODE_RE.test(digits)) return { ok: true, value: digits };

  return {
    ok: false,
    reason: "Enter a 10-digit US number, a +country-code number, or a short code"
  };
}
