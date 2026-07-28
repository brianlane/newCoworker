import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/promotions", () => ({
  getPromotionByCode: vi.fn(),
  countPromotionRedemptions: vi.fn()
}));

import { countPromotionRedemptions, getPromotionByCode } from "@/lib/db/promotions";
import type { PromotionRow } from "@/lib/db/promotions";
import {
  comparisonCycles,
  computePromotionDiscountCents,
  evaluatePromotion,
  FOREVER_COMPARISON_MONTHS,
  normalizePromotionCode,
  promotionLifecycle,
  validatePromotionCode
} from "@/lib/promotions/validate";

const NOW = new Date("2026-07-15T12:00:00Z");

function promo(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: "aaaa0000-0000-4000-8000-000000000001",
    code: "SUMMER20",
    name: "Summer 2026",
    percent_off: 20,
    amount_off_cents: null,
    duration: "once",
    duration_in_months: null,
    allowed_tiers: ["starter", "standard"],
    allowed_periods: ["monthly", "annual", "biennial"],
    starts_at: "2026-07-01T00:00:00Z",
    ends_at: null,
    max_redemptions: null,
    active: true,
    stripe_coupon_id: "coupon_1",
    stripe_promotion_code_id: "promo_1",
    created_by: "admin@test.com",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

describe("promotions/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizePromotionCode", () => {
    it("trims and upper-cases what the customer typed", () => {
      expect(normalizePromotionCode("  summer20 ")).toBe("SUMMER20");
      expect(normalizePromotionCode("SUMMER20")).toBe("SUMMER20");
    });
  });

  describe("computePromotionDiscountCents", () => {
    it("takes a percentage off the plan list price", () => {
      // Standard biennial list = $99 x 24 = $2,376; 20% = $475.20.
      expect(
        computePromotionDiscountCents({ percent_off: 20, amount_off_cents: null }, "standard", "biennial")
      ).toBe(47520);
    });

    it("rounds a fractional percentage to whole cents", () => {
      // Starter monthly list = $26.99; 33% = $8.9067 -> $8.91.
      expect(
        computePromotionDiscountCents({ percent_off: 33, amount_off_cents: null }, "starter", "monthly")
      ).toBe(891);
    });

    it("takes a fixed amount off", () => {
      expect(
        computePromotionDiscountCents({ percent_off: null, amount_off_cents: 5000 }, "standard", "monthly")
      ).toBe(5000);
    });

    it("never discounts more than the plan line, so the carrier fee stays payable", () => {
      expect(
        computePromotionDiscountCents(
          { percent_off: null, amount_off_cents: 100_000 },
          "starter",
          "monthly"
        )
      ).toBe(2699);
    });

    it("treats a shapeless row (neither value set) as no discount", () => {
      expect(
        computePromotionDiscountCents({ percent_off: null, amount_off_cents: null }, "starter", "monthly")
      ).toBe(0);
    });
  });

  describe("promotionLifecycle", () => {
    it("reports active inside the window with the toggle on", () => {
      expect(promotionLifecycle(promo(), 0, NOW)).toBe("active");
    });

    it("reports scheduled before starts_at", () => {
      expect(promotionLifecycle(promo({ starts_at: "2026-08-01T00:00:00Z" }), 0, NOW)).toBe(
        "scheduled"
      );
    });

    it("reports expired once ends_at has passed, even with the toggle on", () => {
      expect(promotionLifecycle(promo({ ends_at: "2026-07-10T00:00:00Z" }), 0, NOW)).toBe("expired");
    });

    it("reports exhausted at the cap", () => {
      expect(promotionLifecycle(promo({ max_redemptions: 5 }), 5, NOW)).toBe("exhausted");
    });

    it("reports off when the toggle is down and nothing else has stopped it", () => {
      expect(promotionLifecycle(promo({ active: false }), 0, NOW)).toBe("off");
    });

    it("counts an unlimited promotion as active however many times it was redeemed", () => {
      expect(promotionLifecycle(promo(), 9999, NOW)).toBe("active");
    });
  });

  describe("evaluatePromotion", () => {
    const base = { tier: "standard" as const, period: "biennial" as const, redemptionCount: 0, now: NOW };

    it("accepts a live code and reports the discount and the new plan total", () => {
      const result = evaluatePromotion(promo(), base);
      expect(result).toEqual({
        ok: true,
        promotion: promo(),
        discountCents: 47520,
        planDueTodayCents: 9900 * 24 - 47520
      });
    });

    it("refuses a toggled-off code", () => {
      expect(evaluatePromotion(promo({ active: false }), base)).toEqual({
        ok: false,
        reason: "inactive"
      });
    });

    it("refuses a code before its start date", () => {
      expect(evaluatePromotion(promo({ starts_at: "2026-08-01T00:00:00Z" }), base)).toEqual({
        ok: false,
        reason: "scheduled"
      });
    });

    it("refuses a code at or after its end date", () => {
      expect(evaluatePromotion(promo({ ends_at: NOW.toISOString() }), base)).toEqual({
        ok: false,
        reason: "expired"
      });
    });

    it("refuses a tier the code does not cover", () => {
      expect(evaluatePromotion(promo({ allowed_tiers: ["starter"] }), base)).toEqual({
        ok: false,
        reason: "tier_not_allowed"
      });
    });

    it("refuses a billing period the code does not cover", () => {
      expect(evaluatePromotion(promo({ allowed_periods: ["monthly"] }), base)).toEqual({
        ok: false,
        reason: "period_not_allowed"
      });
    });

    it("refuses a code that has hit its cap", () => {
      expect(
        evaluatePromotion(promo({ max_redemptions: 2 }), { ...base, redemptionCount: 2 })
      ).toEqual({ ok: false, reason: "exhausted" });
    });

    it("allows a capped code that still has room", () => {
      const result = evaluatePromotion(promo({ max_redemptions: 2 }), {
        ...base,
        redemptionCount: 1
      });
      expect(result.ok).toBe(true);
    });

    it("refuses a monthly code that would cost MORE than the standard intro price", () => {
      // 10% off starter monthly's $26.99 list is $24.29, which is worse than
      // the $15.99 intro price the promo would replace.
      expect(
        evaluatePromotion(promo({ percent_off: 10 }), {
          ...base,
          tier: "starter",
          period: "monthly"
        })
      ).toEqual({ ok: false, reason: "not_better" });
    });

    it("allows a monthly code that genuinely beats the intro price", () => {
      const result = evaluatePromotion(promo({ percent_off: 50 }), {
        ...base,
        tier: "starter",
        period: "monthly"
      });
      expect(result).toEqual({
        ok: true,
        promotion: promo({ percent_off: 50 }),
        discountCents: 1350,
        planDueTodayCents: 1349
      });
    });

    it("weighs a forever code over a year, so 20% off every month beats the one-time intro", () => {
      // Month one alone is worse ($21.59 vs $15.99), but 12 x $21.59 = $259.08
      // beats $15.99 + 11 x $26.99 = $312.88. Judging by the first invoice
      // only used to refuse this genuinely better deal.
      const result = evaluatePromotion(promo({ percent_off: 20, duration: "forever" }), {
        ...base,
        tier: "starter",
        period: "monthly"
      });
      expect(result).toMatchObject({ ok: true, discountCents: 540, planDueTodayCents: 2159 });
    });

    it("weighs a repeating code over its own span", () => {
      // 3 x $21.59 = $64.77 vs $15.99 + 2 x $26.99 = $69.97.
      const result = evaluatePromotion(
        promo({ percent_off: 20, duration: "repeating", duration_in_months: 3 }),
        { ...base, tier: "starter", period: "monthly" }
      );
      expect(result.ok).toBe(true);
    });

    it("still refuses a repeating code whose whole span loses to the intro discount", () => {
      // Two months of 20% saves $10.80; the intro discount saves $11.00.
      expect(
        evaluatePromotion(
          promo({ percent_off: 20, duration: "repeating", duration_in_months: 2 }),
          { ...base, tier: "starter", period: "monthly" }
        )
      ).toEqual({ ok: false, reason: "not_better" });
    });

    it("compares a term plan over its single prepaid invoice whatever the duration says", () => {
      // One prepaid invoice, no intro discount to displace: any real discount
      // is an improvement, and post-term pricing belongs to the commitment
      // schedule, not this code.
      const result = evaluatePromotion(promo({ percent_off: 20, duration: "forever" }), base);
      expect(result).toMatchObject({ ok: true, discountCents: 47520 });
    });
  });

  describe("comparisonCycles", () => {
    it("is one cycle for once codes and for every term plan", () => {
      expect(comparisonCycles({ duration: "once", duration_in_months: null }, "monthly")).toBe(1);
      expect(comparisonCycles({ duration: "forever", duration_in_months: null }, "biennial")).toBe(1);
      expect(
        comparisonCycles({ duration: "repeating", duration_in_months: 6 }, "annual")
      ).toBe(1);
    });

    it("is the covered span on monthly plans", () => {
      expect(
        comparisonCycles({ duration: "repeating", duration_in_months: 3 }, "monthly")
      ).toBe(3);
      expect(comparisonCycles({ duration: "forever", duration_in_months: null }, "monthly")).toBe(
        FOREVER_COMPARISON_MONTHS
      );
    });

    it("falls back to one month for a repeating row missing its month count", () => {
      // The table CHECK makes this unrepresentable; the fallback just keeps
      // the math defined if it ever weren't.
      expect(
        comparisonCycles({ duration: "repeating", duration_in_months: null }, "monthly")
      ).toBe(1);
    });
  });

  describe("validatePromotionCode", () => {
    it("normalizes the code before the lookup and returns the evaluation", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(promo());
      const result = await validatePromotionCode({
        code: " summer20 ",
        tier: "standard",
        period: "biennial",
        now: NOW
      });
      expect(getPromotionByCode).toHaveBeenCalledWith("SUMMER20");
      expect(result.ok).toBe(true);
    });

    it("reports an unknown code", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(null);
      await expect(
        validatePromotionCode({ code: "NOPE", tier: "starter", period: "annual", now: NOW })
      ).resolves.toEqual({ ok: false, reason: "not_found" });
      expect(countPromotionRedemptions).not.toHaveBeenCalled();
    });

    it("skips the redemption count when the promotion is uncapped", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(promo());
      await validatePromotionCode({
        code: "SUMMER20",
        tier: "standard",
        period: "annual",
        now: NOW
      });
      expect(countPromotionRedemptions).not.toHaveBeenCalled();
    });

    it("counts redemptions when a cap could bite, and enforces it", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(promo({ max_redemptions: 3 }));
      vi.mocked(countPromotionRedemptions).mockResolvedValue(3);
      await expect(
        validatePromotionCode({
          code: "SUMMER20",
          tier: "standard",
          period: "annual",
          now: NOW
        })
      ).resolves.toEqual({ ok: false, reason: "exhausted" });
      expect(countPromotionRedemptions).toHaveBeenCalledWith(promo().id);
    });

    it("defaults the clock to the real now when the caller does not pin one", async () => {
      vi.mocked(getPromotionByCode).mockResolvedValue(
        promo({ starts_at: "2099-01-01T00:00:00Z" })
      );
      await expect(
        validatePromotionCode({ code: "SUMMER20", tier: "standard", period: "annual" })
      ).resolves.toEqual({ ok: false, reason: "scheduled" });
    });
  });
});
