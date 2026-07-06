/**
 * Pure parser for the comma'd "<digit>, <free text>" SMS reply shape used by
 * AiFlow team offers: claim with a timeframe ("1, 20 min"), pass with a reason
 * ("2, out of town"), and the unclaim "86, <note>" path.
 *
 * Lives in `_shared` (not the telnyx-sms-inbound entrypoint) so it can be unit
 * tested under vitest without booting the Deno HTTP server, and so the worker
 * and webhook share one definition of the cap.
 */

/** Cap the comma'd free text so a reply can't bloat the owner's notice. */
export const MAX_CLAIM_TIMEFRAME_LEN = 120;

/**
 * Parse the comma'd reply shape, "<n>, <text>" (e.g. "1, 20 min" claim+ETA,
 * "2, out of town" pass+reason, "86, a few days"). The comma + free text is
 * the affordance for "accept and say when you'll reach out" / "pass and say
 * why"; the exact leading digit's meaning is the caller's job, so we accept
 * ANY 1-2 digit lead — the comma is what distinguishes the annotated form from
 * a bare digit. Returns null when there's no comma'd text. The digit "86" is
 * routed to the unclaim path by the caller.
 */
export function parseClaimWithTimeframe(
  body: string
): { digit: string; timeframe: string } | null {
  // The ETA group requires a leading non-space (`\S`), so a bare "4," or "4,   "
  // (only whitespace after the comma) fails to match and returns null here — and
  // a match's trimmed ETA is always non-empty (its first char is that `\S`).
  const m = /^(\d{1,2})\s*,\s*(\S.*)$/.exec(body.trim());
  if (!m) return null;
  return { digit: m[1], timeframe: m[2].trim().slice(0, MAX_CLAIM_TIMEFRAME_LEN) };
}
