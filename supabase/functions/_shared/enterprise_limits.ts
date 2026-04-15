import { VOICE_RES_LIMITS } from "./voice_reservation_limits";

const ENTERPRISE_VOICE_CAP_SECONDS_DEFAULT =
  VOICE_RES_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod;
const ENTERPRISE_MAX_CONCURRENT_DEFAULT = VOICE_RES_LIMITS.enterprise.maxConcurrentCalls;

function num(
  v: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min || n > max) return fallback;
  return n;
}

/** Resolve included voice seconds + concurrent cap for voice_reserve_for_call. */
export function resolveEnterpriseVoiceReservation(raw: unknown): {
  tierCapSeconds: number;
  maxConcurrent: number;
} {
  if (!raw || typeof raw !== "object") {
    return {
      tierCapSeconds: ENTERPRISE_VOICE_CAP_SECONDS_DEFAULT,
      maxConcurrent: ENTERPRISE_MAX_CONCURRENT_DEFAULT
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    tierCapSeconds: num(
      o.voiceIncludedSecondsPerStripePeriod,
      60,
      100_000_000,
      ENTERPRISE_VOICE_CAP_SECONDS_DEFAULT
    ),
    maxConcurrent: num(o.maxConcurrentCalls, 1, 1000, ENTERPRISE_MAX_CONCURRENT_DEFAULT)
  };
}
