import { afterEach, describe, expect, it, vi } from "vitest";
import * as limitsModule from "@/lib/plans/limits";

const { TIER_LIMITS, getTierLimits, effectiveSmsMonthlyCap } = limitsModule;
import { concurrentCallsLine, smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";

describe("tier limits", () => {
  describe("starter limits", () => {
    it("starter has no legacy daily voice cap (Telnyx uses per–Stripe-period pool)", () => {
      expect(TIER_LIMITS.starter.voiceMinutesPerDay).toBe(Infinity);
    });

    it("starter has 1500 included voice seconds per Stripe period (Jul 2026 rebalance)", () => {
      expect(TIER_LIMITS.starter.voiceIncludedSecondsPerStripePeriod).toBe(1500);
    });

    it("starter has strict monthly SMS cap (UTC month)", () => {
      expect(TIER_LIMITS.starter.smsPerMonth).toBe(150);
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
    it("standard has unlimited voice minutes (daily_usage)", () => {
      expect(TIER_LIMITS.standard.voiceMinutesPerDay).toBe(Infinity);
    });

    it("standard has 15000 included voice seconds per Stripe period", () => {
      expect(TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod).toBe(15000);
    });

    it("standard has strict monthly SMS cap", () => {
      expect(TIER_LIMITS.standard.smsPerMonth).toBe(5000);
    });

    it("standard has 10 concurrent calls max (tier relaunch)", () => {
      expect(TIER_LIMITS.standard.maxConcurrentCalls).toBe(10);
    });

    it("standard SMS is not throttled", () => {
      expect(TIER_LIMITS.standard.smsThrottled).toBe(false);
    });

    it("standard memory is lossless", () => {
      expect(TIER_LIMITS.standard.memoryType).toBe("lossless");
    });
  });

  describe("enterprise limits", () => {
    it("enterprise has unlimited voice minutes (daily_usage)", () => {
      expect(TIER_LIMITS.enterprise.voiceMinutesPerDay).toBe(Infinity);
    });

    it("enterprise has 150000 included voice seconds per Stripe period", () => {
      expect(TIER_LIMITS.enterprise.voiceIncludedSecondsPerStripePeriod).toBe(150000);
    });

    it("enterprise has unlimited SMS by default", () => {
      expect(TIER_LIMITS.enterprise.smsPerMonth).toBe(Infinity);
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

  describe("usage copy helpers", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("voice and SMS lines match tier defaults", () => {
      expect(voiceMinutesLine("starter")).toBe("25 voice minutes");
      expect(smsMonthlyLine("starter")).toBe("150 texts / month");
      expect(voiceMinutesLine("standard")).toBe("250 voice minutes");
      expect(smsMonthlyLine("standard")).toBe("5000 texts / month");
      expect(voiceMinutesLine("enterprise")).toBe("2,500 voice minutes");
      expect(smsMonthlyLine("enterprise")).toBe("Unlimited SMS / month");
    });

    it("concurrentCallsLine pluralizes and handles non-finite caps", () => {
      expect(concurrentCallsLine(1)).toBe("1 concurrent call");
      expect(concurrentCallsLine(10)).toBe("Up to 10 concurrent calls");
      expect(concurrentCallsLine(Number.POSITIVE_INFINITY)).toBe("Custom concurrent calls");
    });

    it("respects enterprise overrides in copy helpers", () => {
      expect(smsMonthlyLine("enterprise", { smsPerMonth: 999 })).toBe("999 texts / month");
      expect(voiceMinutesLine("enterprise", { voiceIncludedSecondsPerStripePeriod: 120 })).toBe(
        "2 voice minutes"
      );
    });

    it("voiceMinutesLine handles non-finite and very large pools like smsMonthlyLine handles Infinity", () => {
      vi.spyOn(limitsModule, "getTierLimits").mockReturnValueOnce({
        ...TIER_LIMITS.enterprise,
        voiceIncludedSecondsPerStripePeriod: Infinity
      });
      expect(voiceMinutesLine("enterprise")).toBe("Unlimited voice");

      vi.spyOn(limitsModule, "getTierLimits").mockReturnValueOnce({
        ...TIER_LIMITS.enterprise,
        voiceIncludedSecondsPerStripePeriod: Number.NaN
      });
      expect(voiceMinutesLine("enterprise")).toBe("Unlimited voice");

      vi.spyOn(limitsModule, "getTierLimits").mockReturnValueOnce({
        ...TIER_LIMITS.enterprise,
        voiceIncludedSecondsPerStripePeriod: 15_000_000
      });
      expect(voiceMinutesLine("enterprise")).toBe("Custom included voice");
    });

    it("voiceMinutesLine handles zero and sub-minute pools", () => {
      const spy = vi.spyOn(limitsModule, "getTierLimits");
      spy
        .mockReturnValueOnce({
          ...TIER_LIMITS.starter,
          voiceIncludedSecondsPerStripePeriod: 0
        })
        .mockReturnValueOnce({
          ...TIER_LIMITS.starter,
          voiceIncludedSecondsPerStripePeriod: 30
        });
      expect(voiceMinutesLine("starter")).toBe("No included voice");
      expect(voiceMinutesLine("starter")).toBe("Under 1 voice minute");
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
      expect(limits.smsPerMonth).toBe(Infinity);
    });
  });

  describe("voiceMinutesPerDay (legacy daily_usage cap)", () => {
    it("starter and standard use Infinity (Telnyx pool is separate)", () => {
      expect(getTierLimits("starter").voiceMinutesPerDay).toBe(Infinity);
      expect(getTierLimits("standard").voiceMinutesPerDay).toBe(Infinity);
    });

    it("enterprise default has no daily voice cap", () => {
      expect(getTierLimits("enterprise").voiceMinutesPerDay).toBe(Infinity);
    });

    it("enterprise override can set a finite daily cap for checkLimitReached", () => {
      expect(getTierLimits("enterprise", { voiceMinutesPerDay: 50 }).voiceMinutesPerDay).toBe(50);
    });
  });

  describe("workspaceConnectionsMax (workspace connection cap)", () => {
    it("starter is capped at 1 workspace connection", () => {
      expect(TIER_LIMITS.starter.workspaceConnectionsMax).toBe(1);
    });

    it("standard is capped at 10 workspace connections", () => {
      expect(TIER_LIMITS.standard.workspaceConnectionsMax).toBe(10);
    });

    it("enterprise is unlimited by default and per-deal overridable", () => {
      expect(TIER_LIMITS.enterprise.workspaceConnectionsMax).toBe(Infinity);
      expect(
        getTierLimits("enterprise", { workspaceConnectionsMax: 8 }).workspaceConnectionsMax
      ).toBe(8);
    });
  });

  describe("all tiers have lossless memory", () => {
    it("all three tiers use lossless memory", () => {
      expect(TIER_LIMITS.starter.memoryType).toBe("lossless");
      expect(TIER_LIMITS.standard.memoryType).toBe("lossless");
      expect(TIER_LIMITS.enterprise.memoryType).toBe("lossless");
    });
  });

  describe("effectiveSmsMonthlyCap (Mexican clamp mirrors the Postgres enforcement)", () => {
    const mx = { phone: "+525512345678", timezone: null };
    const us = { phone: "(602) 555-0100", timezone: null };

    it("clamps Mexican non-enterprise tenants to 100 on every tier", () => {
      expect(effectiveSmsMonthlyCap("starter", undefined, mx)).toBe(100);
      expect(effectiveSmsMonthlyCap("standard", undefined, mx)).toBe(100);
    });

    it("leaves US/CA tenants on the tier cap", () => {
      expect(effectiveSmsMonthlyCap("starter", undefined, us)).toBe(
        TIER_LIMITS.starter.smsPerMonth
      );
      expect(effectiveSmsMonthlyCap("standard", undefined, us)).toBe(
        TIER_LIMITS.standard.smsPerMonth
      );
      expect(
        effectiveSmsMonthlyCap("standard", undefined, {
          phone: "(416) 456-0696",
          timezone: "America/Toronto"
        })
      ).toBe(TIER_LIMITS.standard.smsPerMonth);
    });

    it("classifies from the timezone when the phone is inconclusive", () => {
      expect(
        effectiveSmsMonthlyCap("standard", undefined, {
          phone: null,
          timezone: "America/Mexico_City"
        })
      ).toBe(100);
    });

    it("exempts enterprise (per-deal limits govern instead)", () => {
      expect(effectiveSmsMonthlyCap("enterprise", undefined, mx)).toBe(Infinity);
      expect(effectiveSmsMonthlyCap("enterprise", { smsPerMonth: 5000 }, mx)).toBe(5000);
    });

    it("smsMonthlyLine renders the per-business override so display matches enforcement", () => {
      expect(smsMonthlyLine("standard", undefined, "en", 100)).toBe("100 texts / month");
      expect(smsMonthlyLine("standard", undefined, "es", 100)).toBe("100 textos / mes");
      expect(smsMonthlyLine("standard")).toBe("5000 texts / month");
      expect(smsMonthlyLine("enterprise", undefined, "en", Infinity)).toBe(
        "Unlimited SMS / month"
      );
    });
  });
});
