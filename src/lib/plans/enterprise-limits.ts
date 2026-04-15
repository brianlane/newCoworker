import { z } from "zod";
import type { TierLimits } from "./limits";

/** Serializable subset of TierLimits for admin/API (omit key to use enterprise default). Unknown keys are stripped (e.g. legacy `memoryType`). */
export const enterpriseLimitsOverrideSchema = z
  .object({
    voiceMinutesPerDay: z.number().positive().finite(),
    voiceIncludedSecondsPerStripePeriod: z.number().int().min(60).max(100_000_000),
    smsPerDay: z.number().positive().finite(),
    callsPerDay: z.number().positive().finite(),
    maxConcurrentCalls: z.number().int().min(1).max(1000),
    smsThrottled: z.boolean()
  })
  .partial();

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
