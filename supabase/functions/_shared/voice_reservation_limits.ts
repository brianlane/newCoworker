/**
 * Included Telnyx voice seconds per Stripe billing period + max concurrent calls
 * (passed to `voice_reserve_for_call` from Edge).
 *
 * Single source of truth: `src/lib/plans/limits.ts` imports these into `TIER_LIMITS`
 * for `voiceIncludedSecondsPerStripePeriod` and `maxConcurrentCalls`.
 */

/**
 * Concurrent-call slots reserved OUT of each tenant's cap for the outbound
 * legs that fire mid-call and are not gated pre-dial: warm transfers of live
 * callers and reach_teammate rings. AI flow dials defer once the tenant's
 * in-flight calls reach (cap - headroom), so a busy AI can never eat the
 * channels a live human needs. Per-tenant override:
 * business_telnyx_settings.voice_outbound_dial_headroom (null = this).
 */
export const TENANT_OUTBOUND_DIAL_HEADROOM_DEFAULT = 3;

export const VOICE_RES_LIMITS = {
  starter: {
    // 10 → 25 min in the Jul 2026 starter rebalance: voice is the cheapest
    // included unit (~$0.028/min all-in ≈ $0.70/mo at full cap), so it grew
    // while the expensive SMS cap shrank (500 → 100).
    voiceIncludedSecondsPerStripePeriod: 1_500,
    maxConcurrentCalls: 1
  },
  standard: {
    voiceIncludedSecondsPerStripePeriod: 15_000,
    // Tier relaunch (Jul 2026): KVM2 load-tested to 20 simultaneous Gemini
    // Live calls with CPU >90% idle; the fleet-wide Gemini TPM pool supports
    // ~45. "Up to 10 concurrent calls" is the advertised Standard cap.
    maxConcurrentCalls: 10
  },
  enterprise: {
    voiceIncludedSecondsPerStripePeriod: 150_000,
    maxConcurrentCalls: 10
  }
} as const;
