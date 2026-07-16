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

/** parseEtaMinutes never returns more than 30 days (mirrors MAX_WAIT_MINUTES). */
export const MAX_ETA_MINUTES = 43200;

/** Duration tokens: "20 min", "1.5 hours", "2h", "1 hr 30 min", ... */
const ETA_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g;

/**
 * Parse a claim timeframe ("20 min", "1 hour", "45") into whole minutes for
 * the `claimed_agent_eta_minutes` engine var. Deliberately conservative: only
 * explicit durations parse (summed when combined, "1 hr 30 min" → 90); a bare
 * number is minutes; anything vague ("tonight", "after work") returns 0 so a
 * consuming wait just uses its base window.
 */
export function parseEtaMinutes(timeframe: string): number {
  const text = timeframe.trim().toLowerCase();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.min(Math.round(Number(text)), MAX_ETA_MINUTES);
  }
  let total = 0;
  let matched = false;
  ETA_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ETA_TOKEN_RE.exec(text)) !== null) {
    matched = true;
    const value = Number(m[1]);
    total += m[2].startsWith("h") ? value * 60 : value;
  }
  if (!matched) return 0;
  return Math.min(Math.round(total), MAX_ETA_MINUTES);
}
