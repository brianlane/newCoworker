/**
 * The asterisk frame that makes an urgent alert unmissable in a phone's
 * message list.
 *
 * Introduced for the $1M+ keep-for-owner lead alert (the owner-direct
 * templates wrapped by scripts/oneshot/realtor-retrigger-guard.ts), now
 * shared so voice warm-handoff notices can carry the same framing when a
 * flow opts in (`options.starAlerts`). The alert BODY is never rewritten,
 * only framed, so a starred message reads exactly like its plain twin.
 *
 * Pure + dependency-free so both the Deno edge functions and the Vitest
 * suite can import it. Lockstep copies of STAR_ROW live in
 * scripts/oneshot/realtor-retrigger-guard.ts and vps/voice-bridge/src/intake.ts
 * (separate builds that cannot import this file); tests/star-block.test.ts
 * pins all three to the same string.
 */

/** A full SMS-width row of asterisks framing an urgent alert. */
export const STAR_ROW = "****************";

/** First line is already an asterisk row (4+ stars) → don't wrap again. */
export function hasStarRow(text: string): boolean {
  return /^\*{4,}\s*(\n|$)/.test(text.trimStart());
}

/**
 * Frame `body` in a row of asterisks above and below. Idempotent: a body
 * that already opens with a star row is returned unchanged, so a re-frame
 * (retried webhook, already-wrapped template) can never stack rows. An
 * empty/whitespace body is returned as-is, framing nothing would send a
 * message made of asterisks.
 */
export function starBlock(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  if (hasStarRow(trimmed)) return trimmed;
  return `${STAR_ROW}\n${trimmed}\n${STAR_ROW}`;
}
