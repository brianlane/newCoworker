import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/promotions", () => ({
  listPromotions: vi.fn(),
  listPromotionRedemptions: vi.fn()
}));

import { listPromotionRedemptions, listPromotions } from "@/lib/db/promotions";
import type { PromotionRedemptionRow, PromotionRow } from "@/lib/db/promotions";
import { aggregatePromotionStats, listPromotionsWithStats } from "@/lib/promotions/stats";

const PROMO_A = "aaaa0000-0000-4000-8000-000000000001";
const PROMO_B = "aaaa0000-0000-4000-8000-000000000002";

function promo(id: string, overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id,
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

function redemption(
  promotionId: string,
  createdAt: string,
  amountCents: number
): PromotionRedemptionRow {
  return {
    id: `r-${promotionId}-${createdAt}`,
    promotion_id: promotionId,
    business_id: "cccc0000-0000-4000-8000-000000000001",
    tier: "standard",
    billing_period: "biennial",
    stripe_session_id: `cs_${createdAt}`,
    amount_discounted_cents: amountCents,
    created_at: createdAt
  };
}

describe("promotions/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("aggregatePromotionStats", () => {
    it("counts, sums, and keeps the latest redemption per promotion", () => {
      const stats = aggregatePromotionStats([
        redemption(PROMO_A, "2026-07-20T00:00:00Z", 47520),
        redemption(PROMO_A, "2026-07-22T00:00:00Z", 10000),
        redemption(PROMO_B, "2026-07-01T00:00:00Z", 500)
      ]);
      expect(stats.get(PROMO_A)).toEqual({
        redemptionCount: 2,
        totalDiscountedCents: 57520,
        lastRedeemedAt: "2026-07-22T00:00:00Z"
      });
      expect(stats.get(PROMO_B)).toEqual({
        redemptionCount: 1,
        totalDiscountedCents: 500,
        lastRedeemedAt: "2026-07-01T00:00:00Z"
      });
    });

    it("keeps the newest timestamp even when the rows arrive newest first", () => {
      const stats = aggregatePromotionStats([
        redemption(PROMO_A, "2026-07-22T00:00:00Z", 100),
        redemption(PROMO_A, "2026-07-20T00:00:00Z", 100)
      ]);
      expect(stats.get(PROMO_A)?.lastRedeemedAt).toBe("2026-07-22T00:00:00Z");
    });

    it("returns an empty map for no redemptions", () => {
      expect(aggregatePromotionStats([]).size).toBe(0);
    });
  });

  describe("listPromotionsWithStats", () => {
    it("attaches stats and the live lifecycle to every promotion", async () => {
      vi.mocked(listPromotions).mockResolvedValue([
        promo(PROMO_A),
        promo(PROMO_B, { active: false })
      ]);
      vi.mocked(listPromotionRedemptions).mockResolvedValue([
        redemption(PROMO_A, "2026-07-20T00:00:00Z", 47520)
      ]);

      const rows = await listPromotionsWithStats(new Date("2026-07-25T00:00:00Z"));
      expect(rows[0].stats).toEqual({
        redemptionCount: 1,
        totalDiscountedCents: 47520,
        lastRedeemedAt: "2026-07-20T00:00:00Z"
      });
      expect(rows[0].lifecycle).toBe("active");
      expect(rows[1].stats).toEqual({
        redemptionCount: 0,
        totalDiscountedCents: 0,
        lastRedeemedAt: null
      });
      expect(rows[1].lifecycle).toBe("off");
    });

    it("defaults the clock to now", async () => {
      vi.mocked(listPromotions).mockResolvedValue([
        promo(PROMO_A, { ends_at: "2020-01-01T00:00:00Z" })
      ]);
      vi.mocked(listPromotionRedemptions).mockResolvedValue([]);
      const rows = await listPromotionsWithStats();
      expect(rows[0].lifecycle).toBe("expired");
    });
  });
});
