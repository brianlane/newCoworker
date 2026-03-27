import { describe, expect, it } from "vitest";
import {
  getTierPricing,
  getPeriodPricing,
  getCommitmentMonths,
  isPaidTier,
  type BillingPeriod,
  type PlanTier
} from "@/lib/plans/tier";

describe("tier pricing", () => {
  describe("getTierPricing", () => {
    it("returns full PlanPricing object for starter", () => {
      const pricing = getTierPricing("starter");
      expect(pricing.setupCents).toBe(0);
      expect(pricing.cancelWindowDays).toBe(30);
      expect(pricing.periods).toBeDefined();
    });

    it("returns full PlanPricing object for standard", () => {
      const pricing = getTierPricing("standard");
      expect(pricing.setupCents).toBe(0);
      expect(pricing.cancelWindowDays).toBe(30);
    });

    it("enterprise has no cancel window", () => {
      const pricing = getTierPricing("enterprise");
      expect(pricing.cancelWindowDays).toBe(0);
    });
  });

  describe("getPeriodPricing – starter", () => {
    it("starter biennial is $9.99/mo (999 cents)", () => {
      expect(getPeriodPricing("starter", "biennial").monthlyCents).toBe(999);
    });

    it("starter biennial renewal is $16.99/mo (1699 cents)", () => {
      expect(getPeriodPricing("starter", "biennial").renewalMonthlyCents).toBe(1699);
    });

    it("starter annual is $10.99/mo (1099 cents)", () => {
      expect(getPeriodPricing("starter", "annual").monthlyCents).toBe(1099);
    });

    it("starter annual renewal is $18.99/mo (1899 cents)", () => {
      expect(getPeriodPricing("starter", "annual").renewalMonthlyCents).toBe(1899);
    });

    it("starter monthly is $15.99/mo (1599 cents)", () => {
      expect(getPeriodPricing("starter", "monthly").monthlyCents).toBe(1599);
    });

    it("starter monthly renewal is $26.99/mo (2699 cents)", () => {
      expect(getPeriodPricing("starter", "monthly").renewalMonthlyCents).toBe(2699);
    });
  });

  describe("getPeriodPricing – standard", () => {
    it("standard biennial is $99/mo (9900 cents)", () => {
      expect(getPeriodPricing("standard", "biennial").monthlyCents).toBe(9900);
    });

    it("standard biennial renewal is $189/mo (18900 cents)", () => {
      expect(getPeriodPricing("standard", "biennial").renewalMonthlyCents).toBe(18900);
    });

    it("standard annual is $109/mo (10900 cents)", () => {
      expect(getPeriodPricing("standard", "annual").monthlyCents).toBe(10900);
    });

    it("standard annual renewal is $209/mo (20900 cents)", () => {
      expect(getPeriodPricing("standard", "annual").renewalMonthlyCents).toBe(20900);
    });

    it("standard monthly is $195/mo (19500 cents)", () => {
      expect(getPeriodPricing("standard", "monthly").monthlyCents).toBe(19500);
    });

    it("standard monthly renewal is $279/mo (27900 cents)", () => {
      expect(getPeriodPricing("standard", "monthly").renewalMonthlyCents).toBe(27900);
    });
  });

  describe("getPeriodPricing – enterprise (custom pricing)", () => {
    it("enterprise all periods have 0 cents (custom pricing)", () => {
      const periods: BillingPeriod[] = ["biennial", "annual", "monthly"];
      for (const p of periods) {
        const price = getPeriodPricing("enterprise", p);
        expect(price.monthlyCents).toBe(0);
        expect(price.renewalMonthlyCents).toBe(0);
      }
    });
  });

  describe("getCommitmentMonths", () => {
    it("biennial is 24 months", () => {
      expect(getCommitmentMonths("biennial")).toBe(24);
    });

    it("annual is 12 months", () => {
      expect(getCommitmentMonths("annual")).toBe(12);
    });

    it("monthly is 1 month", () => {
      expect(getCommitmentMonths("monthly")).toBe(1);
    });
  });

  describe("cancelWindowDays", () => {
    it("starter has 30-day cancel window", () => {
      expect(getTierPricing("starter").cancelWindowDays).toBe(30);
    });

    it("standard has 30-day cancel window", () => {
      expect(getTierPricing("standard").cancelWindowDays).toBe(30);
    });
  });

  describe("isPaidTier", () => {
    it("marks enterprise as non-paid", () => {
      expect(isPaidTier("enterprise")).toBe(false);
    });

    it("marks starter as paid", () => {
      expect(isPaidTier("starter")).toBe(true);
    });

    it("marks standard as paid", () => {
      expect(isPaidTier("standard")).toBe(true);
    });
  });

  describe("24-month total commitment math", () => {
    it("starter 24mo total is $239.76 (999 * 24 = 23976 cents)", () => {
      const { monthlyCents } = getPeriodPricing("starter", "biennial");
      expect(monthlyCents * 24).toBe(23976);
    });

    it("standard 24mo total is $2376 (9900 * 24 = 237600 cents)", () => {
      const { monthlyCents } = getPeriodPricing("standard", "biennial");
      expect(monthlyCents * 24).toBe(237600);
    });
  });
});
