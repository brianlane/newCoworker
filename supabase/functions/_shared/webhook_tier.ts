/**
 * Canonical tier predicate for the external-webhook perk (Standard+).
 *
 * Single source of truth shared by the app (`src/lib/plans/webhooks.ts`
 * imports it into the route/event gates) and the webhook-dispatcher Edge
 * cron (`_shared/webhook_dispatch.ts` skips starter subscriptions at
 * delivery time), so the ingress and egress halves can never drift.
 */
export function webhooksAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}
