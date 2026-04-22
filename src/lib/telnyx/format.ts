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
