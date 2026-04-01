import { listBusinesses } from "@/lib/db/businesses";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { getRecentAlertsAll, getRecentLogsAll } from "@/lib/db/logs";
import { getPeriodPricing } from "@/lib/plans/tier";
import type { BillingPeriod } from "@/lib/plans/tier";
import { formatAdminLabel, getLogBadgeVariant, getMonthLabel } from "@/lib/admin/dashboard";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";

export const dynamic = "force-dynamic";

function formatMoney(cents: number): string {
  if (cents >= 100_000) return `$${(cents / 100_000).toFixed(1)}k`;
  return `$${(cents / 100).toFixed(0)}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function AdminDashboardPage() {
  const [businesses, alerts, recentLogs] = await Promise.all([
    listBusinesses(),
    getRecentAlertsAll(10),
    getRecentLogsAll(8)
  ]);

  const subscriptionMap = await listSubscriptionsByBusinessIds(businesses.map((b) => b.id));
  const subscriptions = Array.from(subscriptionMap.values());

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalClients = businesses.length;
  const onlineCount = businesses.filter((b) => b.status === "online").length;
  const activeSubCount = subscriptions.filter((s) => s.status === "active").length;
  const pendingSubCount = subscriptions.filter((s) => s.status === "pending").length;

  // Estimated MRR: sum active subscription monthly cents
  const mrrCents = subscriptions
    .filter((s) => s.status === "active")
    .reduce((sum, s) => {
      if (s.tier === "enterprise") return sum;
      const period: BillingPeriod = (s.billing_period as BillingPeriod) ?? "monthly";
      const pricing = getPeriodPricing(s.tier, period);
      return sum + pricing.monthlyCents;
    }, 0);

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
        <h1 className="text-2xl font-bold text-parchment">Dashboard</h1>
        <p className="text-sm text-parchment/50 mt-1">Business health at a glance.</p>
      </div>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-4 gap-4">
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
          <p className="text-3xl font-bold text-parchment">{formatMoney(mrrCents)}</p>
          <p className="text-xs text-parchment/30 mt-1">based on active plans</p>
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
      <div className="grid grid-cols-3 gap-4">
        {/* Signup sparkline */}
        <Card className="col-span-2">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            New Signups — Last 6 Months
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

      {/* ── Bottom row: alerts + recent activity ── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Alerts */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Recent Alerts
            </h2>
            {alerts.length > 0 && (
              <Badge variant="error">{alerts.length}</Badge>
            )}
          </div>
          {alerts.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No alerts — all clear.</p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {alerts.map((log) => (
                <li key={log.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`/admin/${log.business_id}`}
                      className="text-xs text-parchment capitalize hover:text-signal-teal truncate block"
                    >
                      {formatAdminLabel(log.task_type)}
                    </a>
                    <p className="text-xs text-parchment/30 font-mono truncate">
                      {log.business_id.slice(0, 8)}…
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={getLogBadgeVariant(log.status)}>
                      {formatAdminLabel(log.status)}
                    </Badge>
                    <span className="text-xs text-parchment/30">{timeAgo(log.created_at)}</span>
                  </div>
                </li>
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
          </div>
          {recentLogs.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {recentLogs.map((log) => (
                <li key={log.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={`/admin/${log.business_id}`}
                      className="text-xs text-parchment capitalize hover:text-signal-teal truncate block"
                    >
                      {formatAdminLabel(log.task_type)}
                    </a>
                    <p className="text-xs text-parchment/30 font-mono truncate">
                      {log.business_id.slice(0, 8)}…
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={getLogBadgeVariant(log.status)}>
                      {formatAdminLabel(log.status)}
                    </Badge>
                    <span className="text-xs text-parchment/30">{timeAgo(log.created_at)}</span>
                  </div>
                </li>
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
