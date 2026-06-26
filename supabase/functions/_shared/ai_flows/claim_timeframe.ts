/**
 * Pure parser for the "claim WITH a timeframe" SMS reply shape used by
 * Dave-routed AiFlow offers (and the late-claim "86" path).
 *
 * Lives in `_shared` (not the telnyx-sms-inbound entrypoint) so it can be unit
 * tested under vitest without booting the Deno HTTP server, and so the worker
 * and webhook share one definition of the cap.
 */

/** Cap the stated ETA so a teammate's reply can't bloat the owner's notice. */
export const MAX_CLAIM_TIMEFRAME_LEN = 120;

/**
 * Parse the "claim WITH a timeframe" reply shape, "<n>, <eta>" (e.g. "4, 20 min",
 * "86, a few days"). The comma + free-text ETA is the affordance for the
 * "accept and say when you'll reach out" option Dave-routed offers advertise; the
 * exact leading digit varies per flow (it's just the displayed option number), so
 * we accept ANY 1-2 digit lead — the comma is what distinguishes a claim+ETA from
 * a bare "2" pass. Returns null when there's no comma'd ETA. The digit "86" is
 * routed to the late-claim path by the caller.
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
