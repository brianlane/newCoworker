import type { PlanTier } from "@/lib/plans/tier";

export type TierLimits = {
  voiceMinutesPerDay: number;
  /** Included voice seconds per Stripe billing period (Telnyx + Gemini path). */
  voiceIncludedSecondsPerStripePeriod: number;
  smsPerDay: number;
  callsPerDay: number;
  maxConcurrentCalls: number;
  smsThrottled: boolean;
  memoryType: "lossless";
};

export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  starter: {
    voiceMinutesPerDay: 60,
    voiceIncludedSecondsPerStripePeriod: 600,
    smsPerDay: 100,
    callsPerDay: 10,
    maxConcurrentCalls: 1,
    smsThrottled: true,
    memoryType: "lossless"
  },
  standard: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: 15000,
    smsPerDay: Infinity,
    callsPerDay: Infinity,
    maxConcurrentCalls: 3,
    smsThrottled: false,
    memoryType: "lossless"
  },
  enterprise: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: 150000,
    smsPerDay: Infinity,
    callsPerDay: Infinity,
    maxConcurrentCalls: 10,
    smsThrottled: false,
    memoryType: "lossless"
  }
};

export function getTierLimits(tier: PlanTier): TierLimits {
  return TIER_LIMITS[tier];
}

export function hasVoiceLimit(tier: PlanTier): boolean {
  return TIER_LIMITS[tier].voiceMinutesPerDay !== Infinity;
}

export function hasSmsThrottle(tier: PlanTier): boolean {
  return TIER_LIMITS[tier].smsThrottled;
}
