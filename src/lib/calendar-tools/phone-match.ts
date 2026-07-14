/**
 * Format- and country-code-tolerant phone comparison, shared by the
 * appointment-lifecycle lookups (Calendly invitee matching, booking-ledger
 * fallback). Phones reach us in mixed shapes — E.164 from the SMS surface,
 * national/pretty-printed from the model or a provider — and strict string
 * equality misses real matches (Bugbot on PR #584).
 */

/** Digits-only view of a phone ("+1 (548) 577-3546" → "15485773546"). */
export function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * The shortest digit string that still identifies a subscriber (national
 * significant numbers are 7+ digits everywhere); anything shorter is too
 * ambiguous to suffix-match safely.
 */
export const MIN_PHONE_MATCH_DIGITS = 7;

/**
 * Country-code-tolerant comparison of two digits-only strings: E.164
 * ("1548…") and national ("548…") forms of the same number agree via suffix
 * containment, while the minimum length keeps a short fragment from
 * matching an unrelated number. Short strings only match exactly.
 */
export function phoneDigitsMatch(a: string, b: string): boolean {
  if (a.length < MIN_PHONE_MATCH_DIGITS || b.length < MIN_PHONE_MATCH_DIGITS) {
    return a.length > 0 && a === b;
  }
  return a.endsWith(b) || b.endsWith(a);
}
