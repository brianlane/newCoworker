import { describe, expect, it } from "vitest";
import {
  COVERAGE_EXEMPT_INDICES,
  buildComparisonGroups,
  coveredIndices,
  listComparisonRows
} from "@/lib/plans/comparison";
import {
  ENTERPRISE_FEATURES,
  STANDARD_FEATURES,
  STARTER_FEATURES,
  getTierCards
} from "@/lib/plans/tier-display";
import type { PlanTier } from "@/lib/plans/tier";

const FEATURES_BY_TIER: Record<PlanTier, string[]> = {
  starter: STARTER_FEATURES,
  standard: STANDARD_FEATURES,
  enterprise: ENTERPRISE_FEATURES
};

describe("pricing comparison table", () => {
  /**
   * The load-bearing test for the whole pricing page design.
   *
   * The plan cards deliberately show only a handful of bullets each (2 / 6 /
   * 5 out of 12 / 24 / 13), which is only honest because the always-open
   * comparison table carries the complete list. This proves it does. Add a
   * feature bullet without a matching table row and this fails, which is the
   * point: a silently-dropped feature is invisible in review.
   */
  describe("covers every feature bullet on every tier", () => {
    for (const tier of ["starter", "standard", "enterprise"] as const) {
      it(`${tier} has a table row for every bullet`, () => {
        const features = FEATURES_BY_TIER[tier];
        const covered = coveredIndices(tier);
        const exempt = new Set(COVERAGE_EXEMPT_INDICES[tier]);
        const uncovered = features
          .map((feature, index) => ({ feature, index }))
          .filter(({ index }) => !covered.has(index) && !exempt.has(index));
        expect(
          uncovered,
          `no comparison row covers: ${uncovered.map((u) => `[${u.index}] ${u.feature}`).join(", ")}`
        ).toEqual([]);
      });

      it(`${tier} coverage indices all point at real bullets`, () => {
        const length = FEATURES_BY_TIER[tier].length;
        for (const index of coveredIndices(tier)) {
          expect(index, `${tier} coverage index out of range`).toBeLessThan(length);
        }
      });
    }
  });

  it("exempts only the 'Everything in X, plus:' lead-in", () => {
    for (const tier of ["standard", "enterprise"] as const) {
      for (const index of COVERAGE_EXEMPT_INDICES[tier]) {
        expect(FEATURES_BY_TIER[tier][index]).toContain("Everything in");
      }
    }
    expect(COVERAGE_EXEMPT_INDICES.starter).toEqual([]);
  });

  it("every card bullet is a real bullet from the tier's full list", () => {
    for (const card of getTierCards("biennial")) {
      for (const feature of card.cardFeatures) {
        expect(card.features).toContain(feature);
      }
    }
  });

  it("has no duplicate row labels", () => {
    const labels = listComparisonRows().map((r) => r.labelKey);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has no duplicate group headings", () => {
    const headings = buildComparisonGroups().map((g) => g.headingKey);
    expect(new Set(headings).size).toBe(headings.length);
  });
});
