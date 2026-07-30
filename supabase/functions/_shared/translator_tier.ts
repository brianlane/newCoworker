/**
 * Canonical tier predicate for live translator mode (Standard+).
 *
 * Shared by the app (`src/lib/plans/translator.ts`) and the Telnyx voice
 * inbound Edge function (answer-time arming of target_legs=both), so a Starter
 * tenant cannot burn double Gemini Live minutes even if a leftover settings
 * flag is still true after a downgrade.
 */
export function translatorAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}
