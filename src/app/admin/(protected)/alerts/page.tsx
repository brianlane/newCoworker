import { getTranslations } from "next-intl/server";
import { listBusinesses } from "@/lib/db/businesses";
import { getRecentAlertsAll } from "@/lib/db/logs";
import { parseActivityDaysParam } from "@/lib/db/activity";
import { getAdminMutedBusinessIds } from "@/lib/db/admin-mutes";
import {
  formatAlertStatusLabel,
  parseAlertStatusesParam,
  summarizeAlertCounts,
  ALERT_FILTER_STATUSES
} from "@/lib/admin/dashboard";
import { AdminAlertRow } from "@/components/admin/feed-rows";
import { AdminFeedFilters, type FeedFilterOption } from "@/components/admin/FeedFilters";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

/** Bounded depth for the see-all view (the dashboard card shows 15). */
const ALERTS_PAGE_LIMIT = 100;

/** Status chips — labels match the badge terms the rows display. */
const TYPE_OPTIONS: FeedFilterOption[] = ALERT_FILTER_STATUSES.map((status) => ({
  value: status,
  label: formatAlertStatusLabel(status)
}));

export default async function AdminAlertsPage(props: {
  searchParams?: Promise<{ types?: string; business?: string; days?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const params = (await props.searchParams) ?? {};
  const statuses = parseAlertStatusesParam(params.types);
  const days = parseActivityDaysParam(params.days);

  const muted = await getAdminMutedBusinessIds();
  const businesses = await listBusinesses();
  // Only a real fleet business id reaches the query — a crafted param that
  // matches nothing simply shows the empty state.
  const businessId = businesses.some((b) => b.id === params.business)
    ? params.business
    : undefined;

  const alerts = await getRecentAlertsAll(ALERTS_PAGE_LIMIT, undefined, {
    excludeBusinessIds: muted.alerts,
    statuses,
    businessId,
    sinceDays: days
  });
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));
  const counts = summarizeAlertCounts(alerts);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("alertsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("alertsSubtitle")}</p>
      </div>

      <AdminFeedFilters
        basePath="/admin/alerts"
        options={TYPE_OPTIONS}
        selected={statuses}
        businesses={businesses.map((b) => ({ id: b.id, name: b.name }))}
        businessId={businessId}
        days={days}
      />

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            {t("alertsTitle")}
          </h2>
          <div className="flex items-center gap-2">
            {counts.errors > 0 && (
              <Badge variant="error">
                {counts.errors} error{counts.errors === 1 ? "" : "s"}
              </Badge>
            )}
            {counts.last24h > 0 && <Badge variant="neutral">{counts.last24h} in 24h</Badge>}
          </div>
        </div>
        {alerts.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">No alerts; all clear.</p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {alerts.map((log) => (
              <AdminAlertRow
                key={log.id}
                log={log}
                businessName={businessNames.get(log.business_id)}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
