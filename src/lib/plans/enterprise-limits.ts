import { z } from "zod";
import type { TierLimits } from "./limits";

function normalizeEnterpriseLimitsRaw(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  /**
   * Legacy `smsPerDay` (short-lived): convert to strict monthly cap on a 30-day basis.
   * `smsPerMonth` is left as-is when present.
   */
  if (o.smsPerMonth == null && typeof o.smsPerDay === "number") {
    o.smsPerMonth = Math.max(1, Math.round(o.smsPerDay * 30));
  }
  delete o.smsPerDay;
  delete o.callsPerMonth;
  delete o.callsPerDay;
  return o;
}

/** Serializable subset of TierLimits for admin/API (omit key to use enterprise default). Unknown keys are stripped (e.g. legacy `memoryType`). */
export const enterpriseLimitsOverrideSchema = z.preprocess(
  normalizeEnterpriseLimitsRaw,
  z
    .object({
      voiceMinutesPerDay: z.number().positive().finite(),
      voiceIncludedSecondsPerStripePeriod: z.number().int().min(60).max(100_000_000),
      smsPerMonth: z.number().positive().finite(),
      maxConcurrentCalls: z.number().int().min(1).max(1000),
      smsThrottled: z.boolean()
    })
    .partial()
);

export type EnterpriseLimitsOverride = z.infer<typeof enterpriseLimitsOverrideSchema>;

export function parseEnterpriseLimitsOverride(raw: unknown): EnterpriseLimitsOverride | null {
  if (raw == null) return null;
  const r = enterpriseLimitsOverrideSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function applyEnterpriseLimitsPatch(base: TierLimits, raw: unknown): TierLimits {
  const patch = parseEnterpriseLimitsOverride(raw);
  if (!patch) return { ...base };
  return {
    ...base,
    ...patch
  };
}
