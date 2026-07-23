import { listBusinesses } from "@/lib/db/businesses";
import { getTranslations } from "next-intl/server";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { getRecentAlertsAll } from "@/lib/db/logs";
import { getFleetRecentActivity } from "@/lib/db/fleet-activity";
import { listSystemLogErrorsAll } from "@/lib/db/system-logs";
import { getAdminMutedBusinessIds } from "@/lib/db/admin-mutes";
import { listVpsInventory } from "@/lib/db/vps-inventory";
import { listActiveEnterpriseDeals } from "@/lib/db/enterprise-deals";
import { getFleetCalendarMonthUsageTotals } from "@/lib/db/usage";
import { getFleetCurrentAiSpendMicros } from "@/lib/db/chat-usage";
import { computeDayCurrentMrr, estimateMonthlyPlatformCost } from "@/lib/admin/mrr";
import { stampRefundExposureFromDb } from "@/lib/admin/mrr-exposure";
import {
  formatAdminLabel,
  getMonthLabel,
  getVpsInventoryBadgeVariant,
  summarizeAlertCounts
} from "@/lib/admin/dashboard";
import { AdminAlertRow, AdminActivityRow } from "@/components/admin/feed-rows";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { timeAgo } from "@/components/admin/feed-rows";

export const dynamic = "force-dynamic";

function formatMoney(cents: number): string {
  if (cents >= 100_000) return `$${(cents / 100_000).toFixed(1)}k`;
  return `$${(cents / 100).toFixed(0)}`;
}

export default async function AdminDashboardPage() {
  const t = await getTranslations("admin.pages");
  // Per-business admin mutes (flipped on each business's admin page) filter
  // the fleet-wide feeds below — fetched first so a muted tenant can't eat
  // the feed row limits.
  const muted = await getAdminMutedBusinessIds();
  const [businesses, alerts, recentActivity, systemErrors, vpsInventory, enterpriseDeals, monthUsage, aiSpendMicros] =
    await Promise.all([
      listBusinesses(),
      getRecentAlertsAll(10, undefined, { excludeBusinessIds: muted.alerts }),
      // Fleet-wide activity across the REAL activity tables (calls, texts,
      // emails, AiFlow runs, new customers, completed coworker work) — not
      // just coworker_logs, which sits stale between provisions. Alerting
      // rows stay in the Recent Alerts card. 15 (vs the alerts card's 10)
      // because activity rows are single-line — this keeps the two bottom
      // columns visually balanced.
      getFleetRecentActivity(15, { excludeBusinessIds: muted.activity }),
      listSystemLogErrorsAll(15, undefined, { excludeBusinessIds: muted.errors }),
      listVpsInventory(),
      listActiveEnterpriseDeals(),
      // Best effort, like the AI spend read: a transient usage-read failure
      // degrades the cost estimate to zero metered usage instead of erroring
      // the whole dashboard.
      getFleetCalendarMonthUsageTotals().catch((err: unknown) => {
        console.error(
          "admin dashboard: fleet usage rollup failed",
          err instanceof Error ? err.message : err
        );
        return { smsSent: 0, voiceMinutes: 0 };
      }),
      getFleetCurrentAiSpendMicros()
    ]);

  const subscriptionMap = await listSubscriptionsByBusinessIds(businesses.map((b) => b.id));
  const subscriptions = Array.from(subscriptionMap.values());

  // Business names for the alert/activity feeds — the list is already
  // fetched above, so the cards can say "Scar Fairy" instead of "856034a7…".
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));
  const alertCounts = summarizeAlertCounts(alerts);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalClients = businesses.length;
  const onlineCount = businesses.filter((b) => b.status === "online").length;
  const activeSubCount = subscriptions.filter((s) => s.status === "active").length;
  const pendingSubCount = subscriptions.filter((s) => s.status === "pending").length;

  // Day-current best-effort MRR (renewal-aware, Stripe-backed only, real
  // enterprise deal prices) and the estimated monthly platform spend against
  // it — see src/lib/admin/mrr.ts. Refund-exposure stamping (which splits
  // out revenue still inside an open 30-day money-back window) is best
  // effort: a profile-read failure degrades to "everything committed"
  // instead of erroring the whole dashboard.
  const mrrSubscriptions = await stampRefundExposureFromDb(subscriptions, businesses).catch(
    (err: unknown) => {
      console.error(
        "admin dashboard: refund-exposure stamping failed",
        err instanceof Error ? err.message : err
      );
      return subscriptions;
    }
  );
  const mrr = computeDayCurrentMrr({ subscriptions: mrrSubscriptions, enterpriseDeals });
  const platformCost = estimateMonthlyPlatformCost({ businesses, monthUsage, aiSpendMicros });
  const netCents = mrr.totalCents - platformCost.totalCents;

  // ── Signup sparkline (last 6 months) ──────────────────────────────────────
  const now = new Date();
  const signupsByMonth: number[] = Array(6).fill(0);
  for (const b of businesses) {
    const created = new Date(b.created_at);
    const monthsBack =
      (now.getFullYear() - created.getFullYear()) * 12 +
      (now.getMonth() - created.getMonth());
    if (monthsBack >= 0 && monthsBack < 6) {
      signupsByMonth[monthsBack]++;
    }
  }
  const sparkMonths = signupsByMonth.map((count, i) => ({
    label: getMonthLabel(5 - i),
    count: signupsByMonth[5 - i]
  }));
  const sparkMax = Math.max(...sparkMonths.map((m) => m.count), 1);

  // ── Tier breakdown ────────────────────────────────────────────────────────
  const tierCounts = {
    starter: businesses.filter((b) => b.tier === "starter").length,
    standard: businesses.filter((b) => b.tier === "standard").length,
    enterprise: businesses.filter((b) => b.tier === "enterprise").length
  };

  // ── Recent signups (last 7 days) ─────────────────────────────────────────
  const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentSignups = businesses
    .filter((b) => new Date(b.created_at).getTime() > sevenDaysAgo)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("dashboardTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("dashboardSubtitle")}</p>
      </div>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Total Clients</p>
          <p className="text-3xl font-bold text-parchment">{totalClients}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {recentSignups.length} new this week
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Active Subs</p>
          <p className="text-3xl font-bold text-claw-green">{activeSubCount}</p>
          {pendingSubCount > 0 && (
            <p className="text-xs text-signal-teal/70 mt-1">{pendingSubCount} pending</p>
          )}
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Est. MRR</p>
          <p className="text-3xl font-bold text-parchment">{formatMoney(mrr.totalCents)}</p>
          <p className="text-xs text-parchment/50 mt-0.5">
            {formatMoney(mrr.committedCents)} ex. refund-window
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            − {formatMoney(platformCost.totalCents)}/mo est. cost ·{" "}
            <span className={netCents >= 0 ? "text-claw-green" : "text-spark-orange"}>
              net {netCents < 0 ? "−" : ""}
              {formatMoney(Math.abs(netCents))}
            </span>
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">VPS Online</p>
          <p className="text-3xl font-bold text-parchment">
            {onlineCount}
            <span className="text-sm text-parchment/40 font-normal">/{totalClients}</span>
          </p>
          <div className="mt-1.5 h-1.5 rounded-full bg-parchment/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-claw-green transition-all"
              style={{ width: totalClients ? `${(onlineCount / totalClients) * 100}%` : "0%" }}
            />
          </div>
        </Card>
      </div>
      {/* ── Middle row: sparkline + tier breakdown ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Signup sparkline */}
        <Card className="lg:col-span-2">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            New Signups: Last 6 Months
          </h2>
          <div className="flex items-end gap-2 h-28">
            {sparkMonths.map((m) => (
              <div key={m.label} className="flex-1 flex flex-col items-center gap-1.5">
                <span className="text-xs text-parchment/50 font-medium">{m.count || ""}</span>
                <div className="w-full flex flex-col justify-end" style={{ height: "80px" }}>
                  <div
                    className="w-full rounded-t-sm bg-signal-teal/60 hover:bg-signal-teal transition-colors"
                    style={{ height: `${Math.max((m.count / sparkMax) * 100, m.count > 0 ? 8 : 0)}%` }}
                  />
                </div>
                <span className="text-xs text-parchment/30">{m.label}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Tier breakdown */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Plan Distribution
          </h2>
          <div className="space-y-3">
            {(["standard", "starter", "enterprise"] as const).map((t) => {
              const count = tierCounts[t];
              const pct = totalClients ? Math.round((count / totalClients) * 100) : 0;
              return (
                <div key={t}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-parchment/70 capitalize">{t}</span>
                    <span className="text-parchment/40">{count} · {pct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-parchment/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        t === "standard"
                          ? "bg-claw-green"
                          : t === "starter"
                            ? "bg-signal-teal"
                            : "bg-spark-orange"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-5 pt-4 border-t border-parchment/10 space-y-2">
            <h3 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-2">
              Subscription Status
            </h3>
            {(["active", "pending", "past_due", "canceled"] as const).map((status) => {
              const count = subscriptions.filter((s) => s.status === status).length;
              if (count === 0 && status !== "active") return null;
              return (
                <div key={status} className="flex items-center justify-between text-xs">
                  <Badge
                    variant={
                      status === "active"
                        ? "success"
                        : status === "past_due"
                          ? "error"
                          : "pending"
                    }
                  >
                      {formatAdminLabel(status)}
                  </Badge>
                  <span className="text-parchment/60 font-medium">{count}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* ── Fleet-wide system errors (rowboat / ollama / telnyx / aiflow / workers) ── */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            System Errors: All Clients
          </h2>
          {systemErrors.length > 0 && <Badge variant="error">{systemErrors.length}</Badge>}
        </div>
        {systemErrors.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No system errors; all clear.
          </p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {systemErrors.map((log) => (
              <li key={log.id} className="py-2.5 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  {log.business_id ? (
                    <a
                      href={`/admin/${log.business_id}`}
                      className="text-xs text-parchment font-medium hover:text-signal-teal truncate"
                    >
                      {log.businesses?.name ?? `${log.business_id.slice(0, 8)}…`}
                    </a>
                  ) : (
                    <span className="text-xs text-parchment/60 font-medium">platform</span>
                  )}
                  <Badge variant="neutral" className="text-[10px]">
                    {log.source}
                  </Badge>
                  <span className="text-xs text-parchment/60 font-mono">{log.event}</span>
                  <span className="text-xs text-parchment/30 ml-auto shrink-0">
                    {timeAgo(log.created_at)}
                  </span>
                </div>
                {log.message && (
                  <p className="text-xs text-parchment/50 truncate">{log.message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── VPS inventory / reuse pool (fleet economics Phase B) ── */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            VPS Inventory: Reuse Pool
          </h2>
          {vpsInventory.filter((v) => v.state === "available").length > 0 && (
            <Badge variant="success">
              {vpsInventory.filter((v) => v.state === "available").length} available
            </Badge>
          )}
        </div>
        {vpsInventory.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No boxes tracked; every provision purchases new.
          </p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {vpsInventory.map((vm) => (
              <li key={vm.vm_id} className="py-2.5 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-parchment font-medium font-mono">
                    {vm.hostname ?? `srv${vm.vm_id}.hstgr.cloud`}
                  </span>
                  <Badge variant="neutral" className="text-[10px] uppercase">
                    {vm.plan}
                  </Badge>
                  <Badge variant={getVpsInventoryBadgeVariant(vm.state)}>{vm.state}</Badge>
                  {vm.assigned_business_id && (
                    <a
                      href={`/admin/${vm.assigned_business_id}`}
                      className="text-xs text-parchment/60 hover:text-signal-teal font-mono"
                    >
                      {vm.assigned_business_id.slice(0, 8)}…
                    </a>
                  )}
                  <span className="text-xs text-parchment/30 ml-auto shrink-0">
                    acquired {timeAgo(vm.acquired_at)}
                  </span>
                </div>
                {vm.notes && (
                  <p className="text-xs text-parchment/50 truncate">{vm.notes}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Bottom row: alerts + recent activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Alerts */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Recent Alerts
            </h2>
            <div className="flex items-center gap-2">
              {alertCounts.errors > 0 && (
                <Badge variant="error">
                  {alertCounts.errors} error{alertCounts.errors === 1 ? "" : "s"}
                </Badge>
              )}
              {alertCounts.last24h > 0 && (
                <Badge variant="neutral">{alertCounts.last24h} in 24h</Badge>
              )}
              <Link
                href="/admin/alerts"
                className="text-xs font-medium text-signal-teal hover:underline"
              >
                {t("seeAll")}
              </Link>
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

        {/* Recent activity */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Recent Activity
            </h2>
            <Link
              href="/admin/activity"
              className="text-xs font-medium text-signal-teal hover:underline"
            >
              {t("seeAll")}
            </Link>
          </div>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {recentActivity.map((item) => (
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

      {/* ── New signups this week ── */}
      {recentSignups.length > 0 && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
            New This Week
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {recentSignups.map((b) => {
              const sub = subscriptionMap.get(b.id);
              return (
                <a
                  key={b.id}
                  href={`/admin/${b.id}`}
                  className="flex items-center justify-between rounded-lg border border-parchment/10 px-3 py-2.5 hover:border-signal-teal/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-parchment font-medium truncate">{b.name}</p>
                    <p className="text-xs text-parchment/40 truncate">{b.owner_email}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 ml-2 shrink-0">
                    <StatusDot status={b.status as "online" | "offline" | "high_load"} />
                    {sub && (
                      <Badge variant={sub.status === "active" ? "success" : "pending"}>
                        {sub.status}
                      </Badge>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
