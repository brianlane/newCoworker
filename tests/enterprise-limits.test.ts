import { describe, expect, it } from "vitest";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { applyEnterpriseLimitsPatch, parseEnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";

describe("enterprise limits overrides", () => {
  it("returns base when raw is null or invalid", () => {
    const base = TIER_LIMITS.enterprise;
    expect(applyEnterpriseLimitsPatch(base, null)).toEqual(base);
    expect(applyEnterpriseLimitsPatch(base, undefined)).toEqual(base);
    expect(applyEnterpriseLimitsPatch(base, { notAField: 1 })).toEqual(base);
  });

  it("parses and applies a partial patch", () => {
    const base = TIER_LIMITS.enterprise;
    const merged = applyEnterpriseLimitsPatch(base, {
      voiceIncludedSecondsPerStripePeriod: 300_000,
      smsThrottled: true
    });
    expect(merged.voiceIncludedSecondsPerStripePeriod).toBe(300_000);
    expect(merged.smsThrottled).toBe(true);
    expect(merged.maxConcurrentCalls).toBe(base.maxConcurrentCalls);
  });

  it("parseEnterpriseLimitsOverride rejects out-of-range values", () => {
    expect(parseEnterpriseLimitsOverride({ voiceIncludedSecondsPerStripePeriod: 30 })).toBe(null);
    expect(parseEnterpriseLimitsOverride({ maxConcurrentCalls: 0 })).toBe(null);
  });
});
