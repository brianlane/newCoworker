/**
 * Word-boundary truncation for human-facing headlines and message bodies.
 *
 * The naive `.slice(0, N)` this replaces cut mid-word with no signal that
 * anything was dropped: Amy Laidlaw's Jul 31 2026 "Texter follow-up needed"
 * alert stored a summary ending "(Mesa, AJ, or Gilbert). Bud", where "Bud"
 * was the front half of "Budget around $412K" and the claimed agent fell off
 * entirely. A truncated string must end on a whole word and visibly signal
 * the cut.
 *
 * Imported by both the Node app (src/) and the Deno edge functions, like
 * contact_owner_target.ts, so keep this file runtime-neutral.
 */

/**
 * Cut `text` to at most `max` characters. Trimmed input that already fits is
 * returned unchanged. A cut lands on the last word boundary that keeps the
 * result (ellipsis included) within `max`, marked with a single "…". Only
 * when the first word alone overflows the budget does the cut fall back to
 * mid-word, so an unbroken string still fits.
 */
export function truncateAtWord(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 0) return "";
  if (trimmed.length <= max) return trimmed;
  if (max === 1) return "…";
  // Reserve one character for the ellipsis. The character just past the cut
  // tells whether the cut split a word: whitespace there means the cut is
  // already clean; anything else means the trailing partial word (and the
  // whitespace run before it, so the ellipsis hugs a word) must go.
  // A one-word overflow has no boundary to retreat to; the replace then
  // matches nothing and the mid-word hard cut stands. `atBoundary` can never
  // be empty: `trimmed` starts with a non-space, so the \s+ can't reach
  // index 0.
  const hard = trimmed.slice(0, max - 1);
  const cutSplitsWord = !/\s/.test(trimmed.charAt(max - 1));
  const atBoundary = cutSplitsWord ? hard.replace(/\s+\S*$/, "") : hard;
  return `${atBoundary.trimEnd()}…`;
}
