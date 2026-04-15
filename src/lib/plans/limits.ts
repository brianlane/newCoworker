import type { PlanTier } from "@/lib/plans/tier";
import { applyEnterpriseLimitsPatch } from "@/lib/plans/enterprise-limits";
import { VOICE_RES_LIMITS } from "../../../supabase/functions/_shared/voice_reservation_limits";

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
    /** Legacy daily_usage voice cap disabled; Telnyx quota uses `voiceIncludedSecondsPerStripePeriod` per Stripe period. */
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod,
    smsPerDay: 100,
    callsPerDay: 10,
    maxConcurrentCalls: VOICE_RES_LIMITS.starter.maxConcurrentCalls,
    smsThrottled: true,
    memoryType: "lossless"
  },
  standard: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod,
    smsPerDay: Infinity,
    callsPerDay: Infinity,
    maxConcurrentCalls: VOICE_RES_LIMITS.standard.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless"
  },
  enterprise: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod,
    smsPerDay: Infinity,
    callsPerDay: Infinity,
    maxConcurrentCalls: VOICE_RES_LIMITS.enterprise.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless"
  }
};

export function getTierLimits(tier: PlanTier, enterpriseLimitsOverride?: unknown): TierLimits {
  if (tier !== "enterprise") return TIER_LIMITS[tier];
  return applyEnterpriseLimitsPatch(TIER_LIMITS.enterprise, enterpriseLimitsOverride);
}

export function hasVoiceLimit(tier: PlanTier, enterpriseLimitsOverride?: unknown): boolean {
  const limits = getTierLimits(tier, enterpriseLimitsOverride);
  if (limits.voiceMinutesPerDay !== Infinity) return true;
  /** Starter is capped on the Telnyx / Stripe-period pool, not on `daily_usage.voice_minutes_used`. */
  return tier === "starter";
}

export function hasSmsThrottle(tier: PlanTier, enterpriseLimitsOverride?: unknown): boolean {
  return getTierLimits(tier, enterpriseLimitsOverride).smsThrottled;
}
