import { getTranslations } from "next-intl/server";
import { listBusinesses } from "@/lib/db/businesses";
import { getFleetRecentActivity } from "@/lib/db/fleet-activity";
import { getAdminMutedBusinessIds } from "@/lib/db/admin-mutes";
import { AdminActivityRow } from "@/components/admin/feed-rows";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

/** Bounded depth for the see-all view (the dashboard card shows 15). */
const ACTIVITY_PAGE_LIMIT = 100;

export default async function AdminActivityPage() {
  const t = await getTranslations("admin.pages");
  const muted = await getAdminMutedBusinessIds();
  const [businesses, items] = await Promise.all([
    listBusinesses(),
    getFleetRecentActivity(ACTIVITY_PAGE_LIMIT, { excludeBusinessIds: muted.activity })
  ]);
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("activityTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("activitySubtitle")}</p>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            {t("activityTitle")}
          </h2>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {items.map((item) => (
              <AdminActivityRow
                key={item.id}
                item={item}
                businessName={businessNames.get(item.businessId)}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
