/**
 * AI call summaries + sentiment are a Standard-tier perk.
 *
 * Every completed voice call gets a short AI digest and a sentiment label on
 * the dashboard (competitors sell this per-seat: Aircall AI Assist
 * $9/license, CloudTalk AI €9/user — our marginal cost is pennies of Gemini
 * Flash inside the tenant's existing shared AI budget). The gate lives
 * server-side; the summarizer re-checks tier at generation time, so a
 * downgrade stops new summaries while already-generated ones remain readable.
 */

export function callSummariesAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}
