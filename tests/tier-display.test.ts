import { describe, expect, it } from "vitest";
import {
  CARRIER_FEE_SETUP_LINE,
  ENTERPRISE_FEATURES,
  PERIOD_LABEL,
  PERIOD_OPTIONS,
  PERIOD_SUMMARY,
  STANDARD_FEATURES,
  STARTER_FEATURES,
  getTierCards,
  getTierSavings
} from "@/lib/plans/tier-display";
import { getPeriodPricing, calculateSavingsPercentage, getCommitmentMonths } from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { formatPriceCents, formatPricePerMonth } from "@/lib/pricing";

describe("tier-display", () => {
  describe("static display data", () => {
    it("lists the three billing periods in longest-commitment-first order", () => {
      expect(PERIOD_OPTIONS.map((o) => o.id)).toEqual(["biennial", "annual", "monthly"]);
      expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(["24 months", "12 months", "1 month"]);
    });

    it("has a label and summary for every period", () => {
      for (const opt of PERIOD_OPTIONS) {
        expect(PERIOD_LABEL[opt.id]).toBeTruthy();
        expect(PERIOD_SUMMARY[opt.id].title).toBeTruthy();
        expect(PERIOD_SUMMARY[opt.id].description).toBeTruthy();
      }
    });

    it("setup line carries the 10DLC fee and the money-back window", () => {
      expect(CARRIER_FEE_SETUP_LINE).toContain("$19.50");
      expect(CARRIER_FEE_SETUP_LINE).toContain("30-day money-back");
    });

    it("feature bullets derive caps from TIER_LIMITS", () => {
      expect(STARTER_FEATURES).toContain(`${TIER_LIMITS.starter.smsPerMonth} SMS`);
      expect(STANDARD_FEATURES).toContain(`${TIER_LIMITS.standard.smsPerMonth} SMS`);
      expect(
        STANDARD_FEATURES.some((f) => f.includes(`${TIER_LIMITS.standard.maxConcurrentCalls} concurrent calls`))
      ).toBe(true);
    });

    it("starter does NOT advertise a free model fallback (KVM1 relaunch: over-cap refuses)", () => {
      expect(STARTER_FEATURES.some((f) => f.includes("fallback"))).toBe(false);
      expect(STANDARD_FEATURES.some((f) => f.includes("free model fallback"))).toBe(true);
    });

    it("standard advertises Zapier but NOT RCS (Enterprise-only since Jul 2026)", () => {
      expect(STANDARD_FEATURES.some((f) => f.includes("RCS"))).toBe(false);
      expect(STANDARD_FEATURES.some((f) => f.includes("8,000+"))).toBe(true);
    });

    it("enterprise advertises branded RCS (own verified sender)", () => {
      expect(ENTERPRISE_FEATURES).toContain(
        "Branded RCS messaging (your own Google-verified sender)"
      );
    });

    it("enterprise bullets are the shipped custom/agency set", () => {
      expect(ENTERPRISE_FEATURES[0]).toBe("Everything in Starter and Standard, plus:");
      expect(ENTERPRISE_FEATURES).toContain(
        "White-label dashboard (your name, logo, colors)"
      );
      expect(ENTERPRISE_FEATURES).toContain("Team access with roles (managers & staff)");
      expect(ENTERPRISE_FEATURES).toContain("Choice of professional voices");
      // Honesty guard: cloning was descoped to the prebuilt voice picker —
      // the pricing page must not promise it.
      expect(ENTERPRISE_FEATURES.join(" ")).not.toContain("cloning");
    });
  });

  describe("getTierCards — biennial", () => {
    const cards = getTierCards("biennial");
    const [starter, standard, enterprise] = cards;

    it("returns starter, standard, enterprise in order", () => {
      expect(cards.map((c) => c.id)).toEqual(["starter", "standard", "enterprise"]);
    });

    it("prices come from tier.ts", () => {
      expect(starter.price).toBe(formatPricePerMonth(getPeriodPricing("starter", "biennial").monthlyCents));
      expect(standard.price).toBe(formatPricePerMonth(getPeriodPricing("standard", "biennial").monthlyCents));
    });

    it("committed periods show renewal after the term and the billed-today total", () => {
      const renewal = formatPricePerMonth(getPeriodPricing("starter", "biennial").renewalMonthlyCents);
      expect(starter.renewal).toBe(`Renews at ${renewal} after 24 months`);
      const total = formatPriceCents(
        getPeriodPricing("starter", "biennial").monthlyCents * getCommitmentMonths("biennial")
      );
      expect(starter.total).toBe(`${total} billed today for the 24-month plan`);
    });

    it("committed periods have no intro offer and no strikethrough price", () => {
      expect(starter.introOffer).toBeUndefined();
      expect(starter.originalPrice).toBeUndefined();
    });

    it("starter gets the Best Value badge only on biennial; standard is always Most Popular", () => {
      expect(starter.badge).toBe("Best Value");
      expect(standard.badge).toBe("Most Popular");
      expect(standard.highlight).toBe(true);
    });

    it("enterprise is the custom-quote card", () => {
      expect(enterprise.price).toBe("Custom");
      expect(enterprise.renewal).toBeUndefined();
      expect(enterprise.total).toBeUndefined();
      expect(enterprise.setup).toBe("Contact us for pricing");
      expect(enterprise.cta).toBe("Contact Sales");
      expect(enterprise.badge).toBeUndefined();
      expect(enterprise.highlight).toBe(false);
    });
  });

  describe("getTierCards — annual", () => {
    const [starter] = getTierCards("annual");

    it("no Best Value badge off-biennial", () => {
      expect(starter.badge).toBeUndefined();
    });

    it("renewal names the 12-month term", () => {
      const renewal = formatPricePerMonth(getPeriodPricing("starter", "annual").renewalMonthlyCents);
      expect(starter.renewal).toBe(`Renews at ${renewal} after 12 months`);
    });
  });

  describe("getTierCards — monthly", () => {
    const [starter, standard] = getTierCards("monthly");

    it("shows the intro discount with the renewal rate struck through", () => {
      const pricing = getPeriodPricing("starter", "monthly");
      const savings = formatPriceCents(pricing.renewalMonthlyCents - pricing.monthlyCents);
      expect(starter.introOffer).toBe(`First month discount saves ${savings}`);
      expect(starter.originalPrice).toBe(formatPricePerMonth(pricing.renewalMonthlyCents));
    });

    it("renewal copy has no term suffix and there is no billed-today total", () => {
      const renewal = formatPricePerMonth(getPeriodPricing("standard", "monthly").renewalMonthlyCents);
      expect(standard.renewal).toBe(`Renews at ${renewal}`);
      expect(standard.total).toBeUndefined();
    });
  });

  describe("getTierSavings", () => {
    it("matches calculateSavingsPercentage for both committed periods", () => {
      for (const tier of ["starter", "standard"] as const) {
        expect(getTierSavings(tier)).toEqual({
          biennial: calculateSavingsPercentage(tier, "biennial"),
          annual: calculateSavingsPercentage(tier, "annual")
        });
      }
    });
  });
});
