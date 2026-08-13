import type { PlanTier } from "@/lib/plans/tier";
import { applyEnterpriseLimitsPatch } from "@/lib/plans/enterprise-limits";
import { resolveBusinessCountry } from "@/lib/plans/business-country";
import { VOICE_RES_LIMITS } from "../../../supabase/functions/_shared/voice_reservation_limits";
import {
  SMS_MONTHLY_CAP_MX,
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
  /** Hard cap on AI image generations per conversation (dashboard thread / texter). */
  imageGenerationsPerSession: number;
  /**
   * Max simultaneous workspace connections (Gmail / Outlook / etc. on
   * /dashboard/integrations/workspace), counted across BOTH transports:
   * first-party (direct) rows and Nango-brokered ones. Since Google and
   * Outlook went first-party (Aug 2026), this is a product tier benefit
   * rather than a vendor quota: each connection costs email and calendar
   * polling cycles, and long-tail Nango connects still draw from the shared
   * account-wide Nango pool (src/lib/nango/account-usage.ts).
   * Infinity = unlimited (enterprise).
   */
  workspaceConnectionsMax: number;
};

export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  starter: {
    /** Legacy daily_usage voice cap disabled; Telnyx quota uses `voiceIncludedSecondsPerStripePeriod` per Stripe period. */
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.starter.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: SMS_MONTHLY_CAP_STARTER,
    maxConcurrentCalls: VOICE_RES_LIMITS.starter.maxConcurrentCalls,
    smsThrottled: true,
    memoryType: "lossless",
    imageGenerationsPerSession: 3,
    workspaceConnectionsMax: 1
  },
  standard: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.standard.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: SMS_MONTHLY_CAP_STANDARD,
    maxConcurrentCalls: VOICE_RES_LIMITS.standard.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless",
    imageGenerationsPerSession: 10,
    workspaceConnectionsMax: 10
  },
  enterprise: {
    voiceMinutesPerDay: Infinity,
    voiceIncludedSecondsPerStripePeriod: VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod,
    smsPerMonth: Infinity,
    maxConcurrentCalls: VOICE_RES_LIMITS.enterprise.maxConcurrentCalls,
    smsThrottled: false,
    memoryType: "lossless",
    imageGenerationsPerSession: 10,
    workspaceConnectionsMax: Infinity
  }
};

export function getTierLimits(tier: PlanTier, enterpriseLimitsOverride?: unknown): TierLimits {
  if (tier !== "enterprise") return TIER_LIMITS[tier];
  return applyEnterpriseLimitsPatch(TIER_LIMITS.enterprise, enterpriseLimitsOverride);
}

/**
 * The SMS monthly cap a specific business actually gets: the tier cap,
 * clamped to SMS_MONTHLY_CAP_MX for Mexican non-enterprise tenants (their
 * US +1 number texts +52 at international rates; see the mx_sms_cap
 * migration, whose Postgres clamp in try_reserve_sms_outbound_slot is the
 * enforcement this display mirrors). Pass the same business row fields the
 * reservation reads (phone + timezone) so the shown allowance can never
 * disagree with the enforced one.
 */
export function effectiveSmsMonthlyCap(
  tier: PlanTier,
  enterpriseLimitsOverride: unknown,
  business: { phone?: string | null; timezone?: string | null }
): number {
  const base = getTierLimits(tier, enterpriseLimitsOverride).smsPerMonth;
  if (tier !== "enterprise" && resolveBusinessCountry(business) === "MX") {
    return Math.min(base, SMS_MONTHLY_CAP_MX);
  }
  return base;
}

/** Per-conversation image generation cap for a tier (Starter = 3, Standard+ = 10). */
export function imageGenerationsPerSessionForTier(
  tier: PlanTier | null | undefined,
  enterpriseLimitsOverride?: unknown
): number {
  const resolved = tier ?? "starter";
  return getTierLimits(resolved, enterpriseLimitsOverride).imageGenerationsPerSession;
}
