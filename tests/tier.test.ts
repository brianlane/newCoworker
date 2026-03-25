import { describe, expect, it } from "vitest";
import { getTierPricing, isPaidTier } from "@/lib/plans/tier";

describe("tier pricing", () => {
  it("returns starter price of $199/month", () => {
    expect(getTierPricing("starter")).toEqual({ monthlyCents: 19900, setupCents: 0 });
  });

  it("marks enterprise as non-paid in checkout flow", () => {
    expect(isPaidTier("enterprise")).toBe(false);
    expect(isPaidTier("standard")).toBe(true);
  });
});
