import { describe, it, expect } from "vitest";
import {
  formatPriceCents,
  formatPricePerMonth,
  calculateCommitmentTotal,
  formatCommitmentTotal,
  getMonthlyRateDisplay,
  getRenewalRateDisplay,
  getFirstCycleDiscountCents,
  hasFirstCycleDiscount,
  getFirstCycleDiscountDisplay
} from "@/lib/pricing";
import { getPeriodPricing, PlanTier, BillingPeriod } from "@/lib/plans/tier";

describe("pricing", () => {
  describe("formatPriceCents", () => {
    it("formats cents to USD string correctly", () => {
      expect(formatPriceCents(999)).toBe("$9.99");
      expect(formatPriceCents(1099)).toBe("$10.99");
      expect(formatPriceCents(1599)).toBe("$15.99");
      expect(formatPriceCents(9900)).toBe("$99");
      expect(formatPriceCents(19500)).toBe("$195");
      expect(formatPriceCents(23976)).toBe("$239.76");
      expect(formatPriceCents(237600)).toBe("$2,376");
      expect(formatPriceCents(237699)).toBe("$2,376.99");
    });
  });

  describe("formatPricePerMonth", () => {
    it("formats price per month with /mo suffix", () => {
      expect(formatPricePerMonth(999)).toBe("$9.99/mo");
      expect(formatPricePerMonth(1099)).toBe("$10.99/mo");
      expect(formatPricePerMonth(9900)).toBe("$99.00/mo");
      expect(formatPricePerMonth(19500)).toBe("$195.00/mo");
    });
  });

  describe("calculateCommitmentTotal", () => {
    it("calculates biennial total for starter tier", () => {
      const result = calculateCommitmentTotal("starter", "biennial");
      expect(result).toBe(999 * 24); // $9.99 * 24 months
    });

    it("calculates annual total for starter tier", () => {
      const result = calculateCommitmentTotal("starter", "annual");
      expect(result).toBe(1099 * 12); // $10.99 * 12 months
    });

    it("calculates monthly total for starter tier", () => {
      const result = calculateCommitmentTotal("starter", "monthly");
      expect(result).toBe(1599 * 1); // $15.99 * 1 month
    });

    it("calculates biennial total for standard tier", () => {
      const result = calculateCommitmentTotal("standard", "biennial");
      expect(result).toBe(9900 * 24); // $99.00 * 24 months
    });

    it("calculates annual total for standard tier", () => {
      const result = calculateCommitmentTotal("standard", "annual");
      expect(result).toBe(10900 * 12); // $109.00 * 12 months
    });

    it("calculates monthly total for standard tier", () => {
      const result = calculateCommitmentTotal("standard", "monthly");
      expect(result).toBe(19500 * 1); // $195.00 * 1 month
    });
  });

  describe("formatCommitmentTotal", () => {
    it("formats commitment total for starter biennial", () => {
      expect(formatCommitmentTotal("starter", "biennial")).toBe("$239.76");
    });

    it("formats commitment total for starter annual", () => {
      expect(formatCommitmentTotal("starter", "annual")).toBe("$131.88");
    });

    it("formats commitment total for starter monthly", () => {
      expect(formatCommitmentTotal("starter", "monthly")).toBe("$15.99");
    });

    it("formats commitment total for standard biennial", () => {
      expect(formatCommitmentTotal("standard", "biennial")).toBe("$2,376");
    });

    it("formats commitment total for standard annual", () => {
      expect(formatCommitmentTotal("standard", "annual")).toBe("$1,308");
    });

    it("formats commitment total for standard monthly", () => {
      expect(formatCommitmentTotal("standard", "monthly")).toBe("$195");
    });
  });

  describe("getMonthlyRateDisplay", () => {
    it("returns monthly rate for starter biennial", () => {
      expect(getMonthlyRateDisplay("starter", "biennial")).toBe("$9.99/mo");
    });

    it("returns monthly rate for starter annual", () => {
      expect(getMonthlyRateDisplay("starter", "annual")).toBe("$10.99/mo");
    });

    it("returns monthly rate for starter monthly", () => {
      expect(getMonthlyRateDisplay("starter", "monthly")).toBe("$15.99/mo");
    });

    it("returns monthly rate for standard biennial", () => {
      expect(getMonthlyRateDisplay("standard", "biennial")).toBe("$99.00/mo");
    });

    it("returns monthly rate for standard annual", () => {
      expect(getMonthlyRateDisplay("standard", "annual")).toBe("$109.00/mo");
    });

    it("returns monthly rate for standard monthly", () => {
      expect(getMonthlyRateDisplay("standard", "monthly")).toBe("$195.00/mo");
    });
  });

  describe("getRenewalRateDisplay", () => {
    it("returns renewal rate for starter biennial", () => {
      expect(getRenewalRateDisplay("starter", "biennial")).toBe("$16.99/mo");
    });

    it("returns renewal rate for starter annual", () => {
      expect(getRenewalRateDisplay("starter", "annual")).toBe("$18.99/mo");
    });

    it("returns renewal rate for starter monthly", () => {
      expect(getRenewalRateDisplay("starter", "monthly")).toBe("$26.99/mo");
    });

    it("returns renewal rate for standard biennial", () => {
      expect(getRenewalRateDisplay("standard", "biennial")).toBe("$189.00/mo");
    });

    it("returns renewal rate for standard annual", () => {
      expect(getRenewalRateDisplay("standard", "annual")).toBe("$209.00/mo");
    });

    it("returns renewal rate for standard monthly", () => {
      expect(getRenewalRateDisplay("standard", "monthly")).toBe("$279.00/mo");
    });
  });

  describe("first-cycle discount helpers", () => {
    it("returns the monthly intro discount amount in cents", () => {
      expect(getFirstCycleDiscountCents("starter", "monthly")).toBe(1100);
      expect(getFirstCycleDiscountCents("standard", "monthly")).toBe(8400);
    });

    it("returns zero when the selected period has no intro discount", () => {
      expect(getFirstCycleDiscountCents("starter", "annual")).toBe(0);
      expect(getFirstCycleDiscountCents("starter", "biennial")).toBe(0);
      expect(getFirstCycleDiscountCents("enterprise", "monthly")).toBe(0);
    });

    it("detects whether a first-cycle discount exists", () => {
      expect(hasFirstCycleDiscount("starter", "monthly")).toBe(true);
      expect(hasFirstCycleDiscount("starter", "annual")).toBe(false);
      expect(hasFirstCycleDiscount("starter", "biennial")).toBe(false);
      expect(hasFirstCycleDiscount("enterprise", "monthly")).toBe(false);
    });

    it("formats the first-cycle discount for display", () => {
      expect(getFirstCycleDiscountDisplay("starter", "monthly")).toBe("$11");
      expect(getFirstCycleDiscountDisplay("standard", "monthly")).toBe("$84");
      expect(getFirstCycleDiscountDisplay("starter", "annual")).toBe("$0");
      expect(getFirstCycleDiscountDisplay("enterprise", "monthly")).toBe("$0");
    });
  });

  describe("integration with tier.ts", () => {
    it("pricing values match source of truth in tier.ts", () => {
      // Starter biennial: $9.99/mo = 999 cents
      const starterBiennial = getPeriodPricing("starter", "biennial");
      expect(starterBiennial.monthlyCents).toBe(999);

      // Standard annual: $109/mo = 10900 cents
      const standardAnnual = getPeriodPricing("standard", "annual");
      expect(standardAnnual.monthlyCents).toBe(10900);
    });
  });
});
