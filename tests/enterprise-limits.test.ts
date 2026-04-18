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

  it("parseEnterpriseLimitsOverride rejects non-object raw like arrays", () => {
    expect(parseEnterpriseLimitsOverride([1, 2])).toBe(null);
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

  it("strips legacy memoryType and still applies known keys", () => {
    const base = TIER_LIMITS.enterprise;
    const merged = applyEnterpriseLimitsPatch(base, {
      memoryType: "lossless",
      maxConcurrentCalls: 7
    });
    expect(merged.maxConcurrentCalls).toBe(7);
    expect(merged.memoryType).toBe("lossless");
  });

  it("maps legacy smsPerDay to monthly cap (×30)", () => {
    const base = TIER_LIMITS.enterprise;
    const merged = applyEnterpriseLimitsPatch(base, { smsPerDay: 25 });
    expect(merged.smsPerMonth).toBe(750);
  });

  it("preserves explicit smsPerMonth", () => {
    const base = TIER_LIMITS.enterprise;
    const merged = applyEnterpriseLimitsPatch(base, { smsPerMonth: 12_000 });
    expect(merged.smsPerMonth).toBe(12_000);
  });

  it("applies enterprise smsPerMonth override", () => {
    const base = TIER_LIMITS.enterprise;
    const merged = applyEnterpriseLimitsPatch(base, { smsPerMonth: 50_000 });
    expect(merged.smsPerMonth).toBe(50_000);
  });
});
