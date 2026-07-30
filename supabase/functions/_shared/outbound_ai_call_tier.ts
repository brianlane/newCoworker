/**
 * Canonical tier predicate for outbound AI calls (Standard+).
 *
 * Shared by the app (`src/lib/plans/outbound-ai-calls.ts`), the
 * telnyx-voice-originate Edge function, and the ai-flow-worker
 * (`place_ai_call` + scheduled `outbound_call` sweeps) so dial-time
 * refusals cannot drift. Inbound voice is gated separately (or not at
 * all) and must not import this.
 */
export function outboundAiCallsAllowedForTier(
  tier: string | null | undefined
): boolean {
  return tier === "standard" || tier === "enterprise";
}
