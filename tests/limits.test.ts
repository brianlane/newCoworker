import { describe, expect, it } from "vitest";
import {
  TIER_LIMITS,
  getTierLimits,
  hasVoiceLimit,
  hasSmsThrottle
} from "@/lib/plans/limits";

describe("tier limits", () => {
  describe("starter limits", () => {
    it("starter has no legacy daily voice cap (Telnyx uses per–Stripe-period pool)", () => {
      expect(TIER_LIMITS.starter.voiceMinutesPerDay).toBe(Infinity);
    });

    it("starter has 600 included voice seconds per Stripe period", () => {
      expect(TIER_LIMITS.starter.voiceIncludedSecondsPerStripePeriod).toBe(600);
    });

    it("starter has 100 SMS per day", () => {
      expect(TIER_LIMITS.starter.smsPerDay).toBe(100);
    });

    it("starter has 10 calls per day", () => {
      expect(TIER_LIMITS.starter.callsPerDay).toBe(10);
    });

    it("starter has 1 concurrent call max", () => {
      expect(TIER_LIMITS.starter.maxConcurrentCalls).toBe(1);
    });

    it("starter SMS is throttled", () => {
      expect(TIER_LIMITS.starter.smsThrottled).toBe(true);
    });

    it("starter memory is lossless", () => {
      expect(TIER_LIMITS.starter.memoryType).toBe("lossless");
    });
  });

  describe("standard limits", () => {
    it("standard has unlimited voice minutes", () => {
      expect(TIER_LIMITS.standard.voiceMinutesPerDay).toBe(Infinity);
    });

    it("standard has 15000 included voice seconds per Stripe period", () => {
      expect(TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod).toBe(15000);
    });

    it("standard has unlimited SMS", () => {
      expect(TIER_LIMITS.standard.smsPerDay).toBe(Infinity);
    });

    it("standard has unlimited calls", () => {
      expect(TIER_LIMITS.standard.callsPerDay).toBe(Infinity);
    });

    it("standard has 3 concurrent calls max", () => {
      expect(TIER_LIMITS.standard.maxConcurrentCalls).toBe(3);
    });

    it("standard SMS is not throttled", () => {
      expect(TIER_LIMITS.standard.smsThrottled).toBe(false);
    });

    it("standard memory is lossless", () => {
      expect(TIER_LIMITS.standard.memoryType).toBe("lossless");
    });
  });

  describe("enterprise limits", () => {
    it("enterprise has unlimited voice minutes", () => {
      expect(TIER_LIMITS.enterprise.voiceMinutesPerDay).toBe(Infinity);
    });

    it("enterprise has 150000 included voice seconds per Stripe period", () => {
      expect(TIER_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod).toBe(150000);
    });

    it("enterprise has unlimited SMS", () => {
      expect(TIER_LIMITS.enterprise.smsPerDay).toBe(Infinity);
    });

    it("enterprise has 10 concurrent calls max", () => {
      expect(TIER_LIMITS.enterprise.maxConcurrentCalls).toBe(10);
    });

    it("enterprise SMS is not throttled", () => {
      expect(TIER_LIMITS.enterprise.smsThrottled).toBe(false);
    });

    it("enterprise memory is lossless", () => {
      expect(TIER_LIMITS.enterprise.memoryType).toBe("lossless");
    });
  });

  describe("getTierLimits", () => {
    it("returns correct limits for starter", () => {
      const limits = getTierLimits("starter");
      expect(limits).toEqual(TIER_LIMITS.starter);
    });

    it("returns correct limits for standard", () => {
      const limits = getTierLimits("standard");
      expect(limits).toEqual(TIER_LIMITS.standard);
    });

    it("returns correct limits for enterprise", () => {
      const limits = getTierLimits("enterprise");
      expect(limits).toEqual(TIER_LIMITS.enterprise);
    });

    it("merges enterprise overrides for voice pool and concurrency", () => {
      const limits = getTierLimits("enterprise", {
        voiceIncludedSecondsPerStripePeriod: 500_000,
        maxConcurrentCalls: 25
      });
      expect(limits.voiceIncludedSecondsPerStripePeriod).toBe(500_000);
      expect(limits.maxConcurrentCalls).toBe(25);
      expect(limits.smsPerDay).toBe(Infinity);
    });
  });

  describe("hasVoiceLimit", () => {
    it("starter has a voice limit", () => {
      expect(hasVoiceLimit("starter")).toBe(true);
    });

    it("standard does not have a voice limit", () => {
      expect(hasVoiceLimit("standard")).toBe(false);
    });

    it("enterprise does not have a voice limit", () => {
      expect(hasVoiceLimit("enterprise")).toBe(false);
    });

    it("enterprise with daily voice cap override is limited", () => {
      expect(hasVoiceLimit("enterprise", { voiceMinutesPerDay: 50 })).toBe(true);
    });
  });

  describe("hasSmsThrottle", () => {
    it("starter SMS is throttled", () => {
      expect(hasSmsThrottle("starter")).toBe(true);
    });

    it("standard SMS is not throttled", () => {
      expect(hasSmsThrottle("standard")).toBe(false);
    });

    it("enterprise SMS is not throttled", () => {
      expect(hasSmsThrottle("enterprise")).toBe(false);
    });
  });

  describe("all tiers have lossless memory", () => {
    it("all three tiers use lossless memory", () => {
      expect(TIER_LIMITS.starter.memoryType).toBe("lossless");
      expect(TIER_LIMITS.standard.memoryType).toBe("lossless");
      expect(TIER_LIMITS.enterprise.memoryType).toBe("lossless");
    });
  });
});
