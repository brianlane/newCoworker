/**
 * Per-tenant freeform SMS emoji intensity (0–5).
 *
 * Canonical copy lives here for the Next.js app (Memory UI + API). The Deno
 * SMS worker mirrors the same values in
 * `supabase/functions/_shared/emoji_intensity.ts`. Keep them in lockstep,
 * `tests/emoji-intensity-parity.test.ts` fails the build on drift.
 */

export const EMOJI_INTENSITY_MIN = 0;
export const EMOJI_INTENSITY_MAX = 5;
/** Fleet default: Light (only when appropriate). */
export const EMOJI_INTENSITY_DEFAULT = 2;

/**
 * Short English titles (Memory UI i18n catalogs mirror these).
 */
export const EMOJI_INTENSITY_UI_TITLES = [
  "None",
  "Rare",
  "Light",
  "Moderate",
  "Every text",
  "Multiple"
] as const;

/**
 * Worker-only instructions (not shown in the Memory UI). Index = intensity.
 */
export const EMOJI_INTENSITY_WORKER_INSTRUCTIONS = [
  "No emoji.",
  "Very rare. Professional, but still available.",
  "Only when appropriate, maybe once in an SMS thread conversation for the day.",
  "Not overboard. Use when fitting and only when beneficial or additive.",
  "At least one emoji on every text.",
  "Multiple on every text, maybe one after every sentence and a row of them at the bottom."
] as const;

export type EmojiIntensity = 0 | 1 | 2 | 3 | 4 | 5;

export function isEmojiIntensity(value: unknown): value is EmojiIntensity {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= EMOJI_INTENSITY_MIN &&
    value <= EMOJI_INTENSITY_MAX
  );
}

/** Coerce unknown / missing config to a valid level; prefer default over clamp-from-garbage. */
export function normalizeEmojiIntensity(value: unknown): EmojiIntensity {
  if (isEmojiIntensity(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (isEmojiIntensity(n)) return n;
  }
  return EMOJI_INTENSITY_DEFAULT;
}

/**
 * Always-injected SMS preamble line for the tenant's emoji intensity.
 * Twin of SMS_IDENTITY_LINE / SMS_GROUNDED_ACTIONS_LINE: vault soft-guidance
 * drifts; this does not.
 */
export function SMS_EMOJI_INTENSITY_LINE(intensity: unknown): string {
  const n = normalizeEmojiIntensity(intensity);
  return (
    `Emoji intensity (${n}/5, ${EMOJI_INTENSITY_UI_TITLES[n]}): ` +
    EMOJI_INTENSITY_WORKER_INSTRUCTIONS[n]
  );
}
