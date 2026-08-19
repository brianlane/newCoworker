import { describe, expect, it } from "vitest";
import {
  buildStandardMultiplierLine,
  buildTierHighlights,
  getCardFeatures,
  getTierCards,
  getTierLeadIn,
  pickFeatures
} from "@/lib/plans/tier-display";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { AI_BUDGET_MONTHLY_CENTS } from "@/lib/plans/ai-budget";
import { formatPriceCents } from "@/lib/pricing";
import type { PlanTier } from "@/lib/plans/tier";

const TIERS: PlanTier[] = ["starter", "standard", "enterprise"];

describe("plan card display data", () => {
  describe("highlight strip", () => {
    it("gives every tier the same four slots in the same order", () => {
      const labelSets = TIERS.map((tier) => buildTierHighlights(tier).map((h) => h.label));
      expect(labelSets[0]).toHaveLength(4);
      // Identical labels across cards is the whole point: the reader compares
      // straight down the column instead of hunting for the matching bullet.
      expect(labelSets[1]).toEqual(labelSets[0]);
      expect(labelSets[2]).toEqual(labelSets[0]);
    });

    it("reads its numbers from TIER_LIMITS, not from hardcoded copy", () => {
      for (const tier of ["starter", "standard"] as const) {
        const values = buildTierHighlights(tier).map((h) => h.value);
        const limits = TIER_LIMITS[tier];
        expect(values[0]).toBe(
          new Intl.NumberFormat("en-US").format(
            Math.round(limits.voiceIncludedSecondsPerStripePeriod / 60)
          )
        );
        expect(values[1]).toBe(new Intl.NumberFormat("en-US").format(limits.smsPerMonth));
        expect(values[2]).toBe(String(limits.maxConcurrentCalls));
        expect(values[3]).toBe(`${formatPriceCents(AI_BUDGET_MONTHLY_CENTS[tier])}/mo`);
      }
    });

    it("shows Starter 25 / 150 / 1 and Standard 250 / 5,000 / 10", () => {
      expect(buildTierHighlights("starter").map((h) => h.value)).toEqual([
        "25",
        "150",
        "1",
        "$5/mo"
      ]);
      expect(buildTierHighlights("standard").map((h) => h.value)).toEqual([
        "250",
        "5,000",
        "10",
        "$10/mo"
      ]);
    });

    it("quotes enterprise as Custom in every slot, matching its price", () => {
      expect(buildTierHighlights("enterprise").map((h) => h.value)).toEqual([
        "Custom",
        "Custom",
        "Custom",
        "Custom"
      ]);
      expect(buildTierHighlights("enterprise", "es").every((h) => h.value === "A medida")).toBe(
        true
      );
    });

    it("translates the labels and the per-month suffix", () => {
      const es = buildTierHighlights("starter", "es");
      expect(es.map((h) => h.label)).toEqual([
        "Minutos de voz",
        "Textos / mes",
        "Llamadas a la vez",
        "Presupuesto de IA"
      ]);
      expect(es[3].value).toBe("$5/mes");
    });
  });

  describe("multiplier line", () => {
    it("computes the ratios from TIER_LIMITS so a cap change cannot leave it stale", () => {
      const voice = Math.round(
        TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod /
          TIER_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
      );
      const texts = Math.round(TIER_LIMITS.standard.smsPerMonth / TIER_LIMITS.starter.smsPerMonth);
      const calls = Math.round(
        TIER_LIMITS.standard.maxConcurrentCalls / TIER_LIMITS.starter.maxConcurrentCalls
      );
      expect(buildStandardMultiplierLine()).toBe(
        `${voice}x the minutes, ${texts}x the texts, ${calls}x the calls at once`
      );
    });

    it("is today's 10x / 33x / 10x, the arithmetic that justifies the 10x price", () => {
      expect(buildStandardMultiplierLine()).toBe(
        "10x the minutes, 33x the texts, 10x the calls at once"
      );
      expect(buildStandardMultiplierLine("es")).toBe(
        "10x los minutos, 33x los textos, 10x las llamadas a la vez"
      );
    });

    it("rides only on the Standard card", () => {
      const [starter, standard, enterprise] = getTierCards("biennial");
      expect(starter.multiplierLine).toBeUndefined();
      expect(standard.multiplierLine).toBe(buildStandardMultiplierLine());
      expect(enterprise.multiplierLine).toBeUndefined();
    });
  });

  describe("card feature subset", () => {
    it("keeps the cards short and close in length", () => {
      // The imbalance this redesign exists to fix: 12 / 24 / 13 full bullets
      // became 5 / 6 / 5 on the cards, so no card is padded and none is a wall.
      expect(getCardFeatures("starter")).toHaveLength(5);
      expect(getCardFeatures("standard")).toHaveLength(6);
      expect(getCardFeatures("enterprise")).toHaveLength(5);
    });

    it("only ever shows strings that exist in the tier's full list", () => {
      for (const locale of ["en", "es"] as const) {
        for (const card of getTierCards("biennial", locale)) {
          for (const feature of card.cardFeatures) {
            expect(card.features).toContain(feature);
          }
        }
      }
    });

    it("picks the same positions in Spanish as in English", () => {
      for (const tier of TIERS) {
        expect(getCardFeatures(tier, "es")).toHaveLength(getCardFeatures(tier).length);
      }
    });

    it("leads Standard's card with the six that Starter plainly lacks", () => {
      expect(getCardFeatures("standard")).toEqual([
        "Outbound AI calls: your coworker can call leads for you",
        "Prospecting: your coworker finds local businesses and emails them",
        "Full webhook support: Meta lead ads, Instagram comments & DMs, and REST API triggers",
        "Full browser skills: operates websites like a person",
        "Zapier: connect 8,000+ apps",
        "AI call summaries & caller sentiment on your dashboard"
      ]);
    });

  });

  describe("lead-in", () => {
    it("frames the higher tiers and is absent on the base tier", () => {
      expect(getTierLeadIn("starter")).toBeUndefined();
      expect(getTierLeadIn("standard")).toBe("Everything in Starter, plus:");
      expect(getTierLeadIn("enterprise")).toBe("Everything in Starter and Standard, plus:");
      expect(getTierLeadIn("standard", "es")).toBe("Todo lo de Starter, más:");
    });

    it("is no longer duplicated as a card bullet", () => {
      for (const card of getTierCards("biennial")) {
        expect(card.cardFeatures).not.toContain(card.leadIn);
      }
    });
  });

  describe("taglines", () => {
    it("gives every tier a one-line audience, in both locales", () => {
      for (const locale of ["en", "es"] as const) {
        for (const card of getTierCards("biennial", locale)) {
          expect(card.tagline.length).toBeGreaterThan(0);
        }
      }
      expect(getTierCards("biennial")[1].tagline).toBe(
        "For a team that wants its coworker chasing leads too."
      );
    });
  });

  describe("pickFeatures guard", () => {
    it("selects by position", () => {
      expect(pickFeatures(["a", "b", "c"], [2, 0])).toEqual(["c", "a"]);
    });

    it("throws rather than rendering a blank bullet when an index falls off the end", () => {
      // A reordered or shortened feature array must fail loudly here instead
      // of silently shipping an empty line on the pricing card.
      expect(() => pickFeatures(["a"], [3])).toThrow("index 3 is out of range (length 1)");
    });
  });
});
