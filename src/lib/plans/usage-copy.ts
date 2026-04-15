import { getTierLimits } from "./limits";
import type { PlanTier } from "./tier";

/** Marketing / UI line for included voice (Telnyx pool per Stripe billing period). */
export function voiceMinutesLine(tier: PlanTier, enterpriseLimitsOverride?: unknown): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  const min = Math.round(L.voiceIncludedSecondsPerStripePeriod / 60);
  return `${min} voice minutes`;
}

/** Strict monthly SMS cap copy. */
export function smsMonthlyLine(tier: PlanTier, enterpriseLimitsOverride?: unknown): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  if (L.smsPerMonth === Infinity) return "Unlimited SMS / month";
  return `${L.smsPerMonth} SMS / month`;
}
