/**
 * Messenger / Instagram DM / WhatsApp conversational AI is a STANDARD+ feature.
 *
 * Same product class as the website chat widget (src/lib/webchat/tier-gate.ts):
 * always-on Gemini replies with booking and lead-capture tools. External
 * webhook *flow* events for first contact are already gated separately
 * (src/lib/plans/webhooks.ts). This gate covers the reply engine only: inbox
 * ingest and owner manual send stay available on Starter.
 *
 * Enforcement lives at the single chokepoint every channel funnels through:
 * src/lib/messenger/worker.ts checks this predicate before running a turn,
 * and the worker is the sole consumer of the reply engine. This module used
 * to also export a throwing assert + error class, but nothing ever called
 * them (the webhook path must ACK Meta fast, so it enqueues without a tier
 * lookup and the worker refuses instead), so they were deleted rather than
 * left as coverage-satisfying dead code.
 */

export function messengerAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "standard" || tier === "enterprise";
}
