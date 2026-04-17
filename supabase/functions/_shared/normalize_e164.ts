/**
 * Coerce a raw phone-number string to E.164 with basic structural validation.
 *
 * E.164 range (ITU-T E.164): total digits after '+' are 1..15, no leading zero on the
 * country code, no non-digit characters in the significant number. US-centric default:
 * bare 10-digit inputs are assumed NANP (+1). 11-digit inputs starting with '1' are
 * treated as NANP. Anything else must already start with '+' or we refuse to guess.
 *
 * Returns null for empty, too-short, or structurally invalid inputs. Previous versions
 * were "always accept" (every `+${digits}` was returned); that caused mis-routed DIDs
 * for international numbers and silent junk rows when webhooks sent malformed fields.
 */
export function normalizeE164(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip formatting characters and keep a single leading '+' if present.
  const cleaned = trimmed.replace(/[^\d+]/g, "");
  if (!cleaned) return null;

  let candidate: string;
  if (cleaned.startsWith("+")) {
    candidate = cleaned;
  } else if (cleaned.length === 10) {
    candidate = `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
    candidate = `+${cleaned}`;
  } else {
    // Refuse to invent a country code for shorter/longer bare inputs (e.g. 7-digit local
    // dialing, 12-digit international without a +). These are structurally invalid E.164.
    return null;
  }

  // Exactly one '+' followed by 1..15 digits; first digit is the country code (1..9).
  if (!/^\+[1-9]\d{0,14}$/.test(candidate)) return null;

  // Minimum sanity: national subscriber numbers are at least 6 digits after the country
  // code for almost every numbering plan. Shorter candidates are almost always typos.
  const digitsOnly = candidate.slice(1);
  if (digitsOnly.length < 7) return null;

  return candidate;
}
