import { Badge } from "@/components/ui/Badge";
import {
  adminAlertHref,
  adminAlertSummary,
  formatAdminLabel,
  formatAlertStatusLabel,
  getLogBadgeVariant
} from "@/lib/admin/dashboard";
import type { LogRow } from "@/lib/db/logs";
import type { FleetActivityItem } from "@/lib/db/fleet-activity";
import { ViewAsItemLink } from "@/components/admin/ViewAsItemLink";

/**
 * Row treatments shared by the admin dashboard's Recent Alerts / Recent
 * Activity cards and their "/admin/alerts" + "/admin/activity" see-all
 * pages, so the compact and full views cannot drift.
 */

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Tenant label: name when known, truncated UUID otherwise (full id on hover). */
function businessLabel(businessName: string | null | undefined, businessId: string): string {
  return businessName ?? `${businessId.slice(0, 8)}…`;
}

export function AdminAlertRow({
  log,
  businessName
}: {
  log: LogRow;
  businessName: string | null | undefined;
}) {
  // Urgent alerts open the exact alert on the tenant's notifications page
  // under view-as; error rows (provisioning/system) have no owner-side page
  // and keep linking to the admin business detail.
  const itemHref = adminAlertHref(log);
  return (
    <li className="py-2.5 space-y-1">
      <div className="flex items-start justify-between gap-3">
        {itemHref ? (
          <ViewAsItemLink
            businessId={log.business_id}
            href={itemHref}
            className="text-xs text-parchment hover:text-signal-teal"
          >
            {adminAlertSummary(log)}
          </ViewAsItemLink>
        ) : (
          <a
            href={`/admin/${log.business_id}`}
            className="text-xs text-parchment hover:text-signal-teal min-w-0"
          >
            {adminAlertSummary(log)}
          </a>
        )}
        <span className="text-xs text-parchment/30 shrink-0">{timeAgo(log.created_at)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/admin/${log.business_id}`}
          className="text-xs text-parchment/50 hover:text-signal-teal truncate"
          title={log.business_id}
        >
          {businessLabel(businessName, log.business_id)}
        </a>
        <Badge variant="neutral" className="text-[10px]">
          {formatAdminLabel(log.task_type)}
        </Badge>
        <Badge variant={getLogBadgeVariant(log.status)} className="text-[10px]">
          {formatAlertStatusLabel(log.status)}
        </Badge>
      </div>
    </li>
  );
}

export function AdminActivityRow({
  item,
  businessName
}: {
  item: FleetActivityItem;
  businessName: string | null | undefined;
}) {
  return (
    <li className="py-2.5 space-y-1">
      <div className="flex items-start justify-between gap-3">
        {/* Opens the item's page in the tenant dashboard under view-as. */}
        <ViewAsItemLink
          businessId={item.businessId}
          href={item.href}
          className="text-xs text-parchment hover:text-signal-teal"
        >
          {item.label}
        </ViewAsItemLink>
        <span className="text-xs text-parchment/30 shrink-0">{timeAgo(item.at)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/admin/${item.businessId}`}
          className="text-xs text-parchment/50 hover:text-signal-teal truncate"
          title={item.businessId}
        >
          {businessLabel(businessName, item.businessId)}
        </a>
        <Badge variant={item.variant} className="text-[10px]">
          {item.badge}
        </Badge>
      </div>
    </li>
  );
}
