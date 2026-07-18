import { getTierLimits } from "./limits";
import type { PlanTier } from "./tier";

/** Locale for the owner-facing usage lines. English is the hard default. */
export type UsageCopyLocale = "en" | "es";

/** Above this (seconds / period), show generic copy instead of a huge minute count. */
const VOICE_INCLUDED_DISPLAY_MAX_SECONDS = 10_000_000;

const voiceMinutesFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Marketing / UI line for included voice (Telnyx pool per Stripe billing period). */
export function voiceMinutesLine(
  tier: PlanTier,
  enterpriseLimitsOverride?: unknown,
  locale: UsageCopyLocale = "en"
): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  const sec = L.voiceIncludedSecondsPerStripePeriod;
  const es = locale === "es";

  if (sec === Infinity || !Number.isFinite(sec)) {
    return es ? "Voz ilimitada" : "Unlimited voice";
  }
  if (sec <= 0) {
    return es ? "Sin voz incluida" : "No included voice";
  }
  if (sec >= VOICE_INCLUDED_DISPLAY_MAX_SECONDS) {
    return es ? "Voz incluida personalizada" : "Custom included voice";
  }

  if (sec < 60) {
    return es ? "Menos de 1 minuto de voz" : "Under 1 voice minute";
  }

  const minRounded = Math.round(sec / 60);
  const formatted = voiceMinutesFormatter.format(minRounded);
  return es ? `${formatted} minutos de voz` : `${formatted} voice minutes`;
}

/** Strict monthly SMS cap copy. */
export function smsMonthlyLine(
  tier: PlanTier,
  enterpriseLimitsOverride?: unknown,
  locale: UsageCopyLocale = "en"
): string {
  const L = getTierLimits(tier, enterpriseLimitsOverride);
  const es = locale === "es";
  if (L.smsPerMonth === Infinity) {
    return es ? "SMS ilimitados / mes" : "Unlimited SMS / month";
  }
  return es ? `${L.smsPerMonth} SMS / mes` : `${L.smsPerMonth} SMS / month`;
}

/** Marketing / UI line for the concurrent-call cap. */
export function concurrentCallsLine(
  maxConcurrentCalls: number,
  locale: UsageCopyLocale = "en"
): string {
  const es = locale === "es";
  if (!Number.isFinite(maxConcurrentCalls)) {
    return es ? "Llamadas simultáneas personalizadas" : "Custom concurrent calls";
  }
  if (maxConcurrentCalls === 1) {
    return es ? "1 llamada simultánea" : "1 concurrent call";
  }
  return es
    ? `Hasta ${maxConcurrentCalls} llamadas simultáneas`
    : `Up to ${maxConcurrentCalls} concurrent calls`;
}

/** Marketing / UI line for per-conversation AI image generation cap. */
export function imageGenerationLine(
  tier: PlanTier,
  enterpriseLimitsOverride?: unknown,
  locale: UsageCopyLocale = "en"
): string {
  const limit = getTierLimits(tier, enterpriseLimitsOverride).imageGenerationsPerSession;
  return locale === "es" ? `${limit} por conversación` : `${limit} per conversation`;
}
