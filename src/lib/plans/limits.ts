import type { PlanTier } from "@/lib/plans/tier";
import { applyEnterpriseLimitsPatch } from "@/lib/plans/enterprise-limits";
import { VOICE_RES_LIMITS } from "../../../supabase/functions/_shared/voice_reservation_limits";

export type TierLimits = {
  voiceMinutesPerDay: number;
  /** Included voice seconds per Stripe billing period (Telnyx + Gemini path). */
  voiceIncludedSecondsPerStripePeriod: number;
  /**
   * SMS quota per calendar month (UTC): sum of `daily_usage.sms_sent` for the month must stay below this.
   */
  smsPerMonth: number;
  maxConcurrentCalls: number;
  smsThrottled: boolean;
  memoryType: "lossless";
};

export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  starter: {
    /** Legacy daily_usage voice cap disabled; Telnyx quota uses `voiceIncludedSecondsPerStripePeriod` per Stripe period. */
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: 750,
    maxConcurrentCalls: VOICE_RES_LIMITS.starter.maxConcurrentCalls,
    smsThrottled: true,
    memoryType: "lossless"
  },
  standard: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: 3000,
    maxConcurrentCalls: VOICE_RES_LIMITS.standard.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless"
  },
  enterprise: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: Infinity,
    maxConcurrentCalls: VOICE_RES_LIMITS.enterprise.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless"
  }
};

export function getTierLimits(tier: PlanTier, enterpriseLimitsOverride?: unknown): TierLimits {
  if (tier !== "enterprise") return TIER_LIMITS[tier];
  return applyEnterpriseLimitsPatch(TIER_LIMITS.enterprise, enterpriseLimitsOverride);
}

/**
 * True when legacy `daily_usage` / `checkLimitReached` may enforce a **daily** voice cap.
 * Starter/standard Telnyx quota uses `voiceIncludedSecondsPerStripePeriod` instead — use
 * `hasIncludedTelnyxVoicePool` + `voiceMinutesLine` for UI copy.
 */
export function hasDailyVoiceMinutesCap(
  tier: PlanTier,
  enterpriseLimitsOverride?: unknown
): boolean {
  return getTierLimits(tier, enterpriseLimitsOverride).voiceMinutesPerDay !== Infinity;
}

/** @deprecated Use `hasDailyVoiceMinutesCap` (same behavior; name reflects daily_usage only). */
export function hasVoiceLimit(tier: PlanTier, enterpriseLimitsOverride?: unknown): boolean {
  return hasDailyVoiceMinutesCap(tier, enterpriseLimitsOverride);
}

/** Included Telnyx voice pool per Stripe period (finite for all default tiers). */
export function hasIncludedTelnyxVoicePool(
  tier: PlanTier,
  enterpriseLimitsOverride?: unknown
): boolean {
  return (
    getTierLimits(tier, enterpriseLimitsOverride).voiceIncludedSecondsPerStripePeriod !== Infinity
  );
}

export function hasSmsThrottle(tier: PlanTier, enterpriseLimitsOverride?: unknown): boolean {
  return getTierLimits(tier, enterpriseLimitsOverride).smsThrottled;
}
