/**
 * The analytics dashboard (call/SMS volume, peak hours, answer rate) and
 * missed-call spike alerts are Standard-tier perks.
 *
 * Competitors gate exactly this behind paid tiers (CloudTalk ties analytics
 * retention to plan level, Aircall sells "Analytics+"); our marginal cost is
 * ~$0 because every input already exists — `daily_usage` counters,
 * `voice_call_transcripts` rows, and `system_logs` blocked-call events. The
 * gate lives server-side in the page/route so the sidebar link can stay
 * visible as an upsell without leaking data.
 */

export const ANALYTICS_UPGRADE_MESSAGE =
  "Business analytics is a Standard plan perk. Upgrade to see call trends, peak hours, and your answer rate.";

export function analyticsAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}
