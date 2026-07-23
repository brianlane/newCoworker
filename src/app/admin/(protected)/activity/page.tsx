import { getTranslations } from "next-intl/server";
import { listBusinesses } from "@/lib/db/businesses";
import {
  getFleetRecentActivity,
  parseFleetActivityKindsParam
} from "@/lib/db/fleet-activity";
import { parseActivityDaysParam } from "@/lib/db/activity";
import { getAdminMutedBusinessIds } from "@/lib/db/admin-mutes";
import { AdminActivityRow } from "@/components/admin/feed-rows";
import { AdminFeedFilters, type FeedFilterOption } from "@/components/admin/FeedFilters";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

/** Bounded depth for the see-all view (the dashboard card shows 15). */
const ACTIVITY_PAGE_LIMIT = 100;

/** Type chips — values are fetch-layer source groups, labels match the badge
 * terms the rows display. */
const TYPE_OPTIONS: FeedFilterOption[] = [
  { value: "call", label: "Call" },
  { value: "sms_inbound", label: "Text in" },
  { value: "sms_outbound", label: "Text out" },
  { value: "email", label: "Email" },
  { value: "aiflow", label: "AiFlow" },
  { value: "customer", label: "New contact" },
  { value: "log", label: "Coworker log" }
];

export default async function AdminActivityPage(props: {
  searchParams?: Promise<{ types?: string; business?: string; days?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const params = (await props.searchParams) ?? {};
  const kinds = parseFleetActivityKindsParam(params.types);
  const days = parseActivityDaysParam(params.days);

  const muted = await getAdminMutedBusinessIds();
  const businesses = await listBusinesses();
  // Only a real fleet business id reaches the query — a crafted param that
  // matches nothing simply shows the empty state.
  const businessId = businesses.some((b) => b.id === params.business)
    ? params.business
    : undefined;

  const items = await getFleetRecentActivity(ACTIVITY_PAGE_LIMIT, {
    excludeBusinessIds: muted.activity,
    kinds,
    businessId,
    sinceDays: days
  });
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("activityTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("activitySubtitle")}</p>
      </div>

      <AdminFeedFilters
        basePath="/admin/activity"
        options={TYPE_OPTIONS}
        selected={kinds}
        businesses={businesses.map((b) => ({ id: b.id, name: b.name }))}
        businessId={businessId}
        days={days}
      />

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
