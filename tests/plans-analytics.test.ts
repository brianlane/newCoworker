import { describe, expect, it } from "vitest";
import {
  ANALYTICS_UPGRADE_MESSAGE,
  analyticsAllowedForTier
} from "@/lib/plans/analytics";

describe("analyticsAllowedForTier", () => {
  it("allows standard and enterprise", () => {
    expect(analyticsAllowedForTier("standard")).toBe(true);
    expect(analyticsAllowedForTier("enterprise")).toBe(true);
  });

  it("denies starter, unknown, and missing tiers", () => {
    expect(analyticsAllowedForTier("starter")).toBe(false);
    expect(analyticsAllowedForTier("premium")).toBe(false);
    expect(analyticsAllowedForTier(null)).toBe(false);
    expect(analyticsAllowedForTier(undefined)).toBe(false);
  });

  it("exports owner-facing upgrade copy", () => {
    expect(ANALYTICS_UPGRADE_MESSAGE).toContain("Standard");
  });
});
