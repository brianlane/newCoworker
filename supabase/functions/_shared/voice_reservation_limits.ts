/**
 * Included Telnyx voice seconds per Stripe billing period + max concurrent calls
 * (passed to `voice_reserve_for_call` from Edge).
 *
 * Single source of truth: `src/lib/plans/limits.ts` imports these into `TIER_LIMITS`
 * for `voiceIncludedSecondsPerStripePeriod` and `maxConcurrentCalls`.
 */

export const VOICE_RES_LIMITS = {
  starter: {
    voiceIncludedSecondsPerStripePeriod: 600,
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
