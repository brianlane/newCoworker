/**
 * Per-promotion redemption stats for the admin page.
 *
 * Redemptions are one row per paid signup, so the whole table is tiny and
 * comfortably aggregated in memory, which keeps the shape a plain function
 * the tests can exercise directly instead of a database view.
 */
import {
  listPromotionRedemptions,
  listPromotions,
  type PromotionRedemptionRow,
  type PromotionRow
} from "@/lib/db/promotions";
import { promotionLifecycle, type PromotionLifecycle } from "./validate";

export type PromotionStats = {
  redemptionCount: number;
  /** What Stripe actually took off across every redemption. */
  totalDiscountedCents: number;
  lastRedeemedAt: string | null;
};

export type PromotionWithStats = PromotionRow & {
  stats: PromotionStats;
  lifecycle: PromotionLifecycle;
  /** The redemptions themselves, newest first, for the per-promotion detail. */
  redemptions: PromotionRedemptionRow[];
};

export const EMPTY_PROMOTION_STATS: PromotionStats = {
  redemptionCount: 0,
  totalDiscountedCents: 0,
  lastRedeemedAt: null
};

export function aggregatePromotionStats(
  redemptions: PromotionRedemptionRow[]
): Map<string, PromotionStats> {
  const byPromotion = new Map<string, PromotionStats>();
  for (const row of redemptions) {
    const current = byPromotion.get(row.promotion_id) ?? { ...EMPTY_PROMOTION_STATS };
    const isLatest =
      current.lastRedeemedAt === null ||
      new Date(row.created_at) > new Date(current.lastRedeemedAt);
    byPromotion.set(row.promotion_id, {
      redemptionCount: current.redemptionCount + 1,
      totalDiscountedCents: current.totalDiscountedCents + row.amount_discounted_cents,
      lastRedeemedAt: isLatest ? row.created_at : current.lastRedeemedAt
    });
  }
  return byPromotion;
}

/** The admin table's payload: every promotion with its stats and live status. */
export async function listPromotionsWithStats(now = new Date()): Promise<PromotionWithStats[]> {
  const [promotions, redemptions] = await Promise.all([
    listPromotions(),
    listPromotionRedemptions()
  ]);
  const statsByPromotion = aggregatePromotionStats(redemptions);
  return promotions.map((promotion) => {
    const stats = statsByPromotion.get(promotion.id) ?? { ...EMPTY_PROMOTION_STATS };
    return {
      ...promotion,
      stats,
      lifecycle: promotionLifecycle(promotion, stats.redemptionCount, now),
      redemptions: redemptions.filter((row) => row.promotion_id === promotion.id)
    };
  });
}
