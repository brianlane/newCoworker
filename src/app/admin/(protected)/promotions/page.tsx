import { listBusinesses } from "@/lib/db/businesses";
import { listPromotionsWithStats } from "@/lib/promotions/stats";
import {
  PromotionsManager,
  type AdminPromotion
} from "@/components/admin/PromotionsManager";

export const dynamic = "force-dynamic";

/** Admin promo-code console for the starter/standard memberships. */
export default async function AdminPromotionsPage() {
  const [promotions, businesses] = await Promise.all([
    listPromotionsWithStats(),
    listBusinesses()
  ]);
  const nameById = new Map(businesses.map((business) => [business.id, business.name]));

  const rows: AdminPromotion[] = promotions.map((promotion) => ({
    ...promotion,
    redemptions: promotion.redemptions.map((redemption) => ({
      ...redemption,
      business_name: nameById.get(redemption.business_id) ?? null
    }))
  }));

  return <PromotionsManager initialPromotions={rows} />;
}
