import { getTierLimits } from "./limits";
import type { PlanTier } from "./tier";

/** Above this (seconds / period), show generic copy instead of a huge minute count. */
const VOICE_INCLUDED_DISPLAY_MAX_SECONDS = 10_000_000;

const voiceMinutesFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Marketing / UI line for included voice (Telnyx pool per Stripe billing period). */
export function voiceMinutesLine(tier: PlanTier, enterpriseLimitsOverride?: unknown): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  const sec = L.voiceIncludedSecondsPerStripePeriod;

  if (sec === Infinity || !Number.isFinite(sec)) {
    return "Unlimited voice / billing period";
  }
  if (sec <= 0) {
    return "No included voice / billing period";
  }
  if (sec >= VOICE_INCLUDED_DISPLAY_MAX_SECONDS) {
    return "Custom included voice / billing period";
  }

  if (sec < 60) {
    return "Under 1 voice minute / billing period";
  }

  const minRounded = Math.round(sec / 60);
  return `${voiceMinutesFormatter.format(minRounded)} voice minutes / billing period`;
}

/** Strict monthly SMS cap copy. */
export function smsMonthlyLine(tier: PlanTier, enterpriseLimitsOverride?: unknown): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  if (L.smsPerMonth === Infinity) return "Unlimited SMS / month";
  return `${L.smsPerMonth} SMS / month`;
}
