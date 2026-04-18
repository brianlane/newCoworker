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
    maxConcurrentCalls: 3
  },
  enterprise: {
    voiceIncludedSecondsPerStripePeriod: 150_000,
    maxConcurrentCalls: 10
  }
} as const;
