import type { PlanTier } from "@/lib/plans/tier";
import { applyEnterpriseLimitsPatch } from "@/lib/plans/enterprise-limits";
import { VOICE_RES_LIMITS } from "../../../supabase/functions/_shared/voice_reservation_limits";
import {
  SMS_MONTHLY_CAP_STARTER,
  SMS_MONTHLY_CAP_STANDARD
} from "../../../supabase/functions/_shared/sms_monthly_limits";

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
    smsPerMonth: SMS_MONTHLY_CAP_STARTER,
    maxConcurrentCalls: VOICE_RES_LIMITS.starter.maxConcurrentCalls,
    smsThrottled: true,
    memoryType: "lossless"
  },
  standard: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: SMS_MONTHLY_CAP_STANDARD,
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
