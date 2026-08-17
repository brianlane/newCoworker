import { listBusinesses } from "@/lib/db/businesses";
import { getTranslations } from "next-intl/server";
import { listAllSubscriptions } from "@/lib/db/subscriptions";
import { listActiveEnterpriseDeals } from "@/lib/db/enterprise-deals";
import { computeDayCurrentMrr } from "@/lib/admin/mrr";
import { stampRefundExposureFromDb } from "@/lib/admin/mrr-exposure";
import {
  computeArpuCents,
  computeChurnStats,
  computeMrrTrend,
  computeTopBusinessRevenue,
  dedupeNewestPerBusiness,
  listPaymentProblems,
  type RevenueSubscription
} from "@/lib/admin/revenue";
import Link from "next/link";
import { formatAdminLabel } from "@/lib/admin/dashboard";
import { loadFleetCostBreakdown } from "@/lib/admin/fleet-cost";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export const dynamic = "force-dynamic";

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })}`;
}

export default async function AdminRevenuePage() {
  const t = await getTranslations("admin.pages");
  const [businesses, subscriptions, deals, fleetCost] = await Promise.all([
    listBusinesses(),
    listAllSubscriptions(),
    listActiveEnterpriseDeals(),
    // Cost data is best effort, the revenue analytics must render even if
    // the cost side is unavailable. This is the SAME shared model the
    // Dashboard and Costs pages use (src/lib/admin/fleet-cost.ts), so Net
    // Margin here is the complete figure, platform-level costs included,
    // and matches what those pages show.
    loadFleetCostBreakdown().catch((err: unknown) => {
      console.error(
        "admin revenue: fleet cost load failed",
        err instanceof Error ? err.message : err
      );
      return null;
    })
  ]);
  const margins = fleetCost?.margins ?? null;
  const breakdown = fleetCost?.breakdown ?? null;

  const revenueSubs: RevenueSubscription[] = subscriptions;
  const businessName = new Map(businesses.map((b) => [b.id, b.name]));

  // Newest row per business for the headline KPI — the same view the admin
  // dashboard's MRR card computes from listSubscriptionsByBusinessIds, so
  // the two never disagree over historical/overlapping rows. Refund-exposure
  // stamping (splits out revenue still inside an open 30-day money-back
  // window) is best effort, mirroring the dashboard card: a profile-read
  // failure degrades to "everything committed" instead of erroring the page.
  const headlineSubs = dedupeNewestPerBusiness(subscriptions);
  const mrrSubscriptions = await stampRefundExposureFromDb(headlineSubs, businesses).catch(
    (err: unknown) => {
      console.error(
        "admin revenue: refund-exposure stamping failed",
        err instanceof Error ? err.message : err
      );
      return headlineSubs;
    }
  );
  const mrr = computeDayCurrentMrr({
    subscriptions: mrrSubscriptions,
    enterpriseDeals: deals
  });
  const arpuCents = computeArpuCents({ subscriptions: revenueSubs, deals });
  const churn = computeChurnStats({ subscriptions: revenueSubs });
  const trend = computeMrrTrend({ subscriptions: revenueSubs, deals, months: 6 });
  // Per-business revenue merged by businessId — its length is the UNIQUE
  // paying-business count (a tenant with both a subscription and an
  // enterprise deal counts once), and the top-10 slice feeds the list.
  const payingBusinesses = computeTopBusinessRevenue({
    subscriptions: revenueSubs,
    deals,
    limit: Number.MAX_SAFE_INTEGER
  });
  const topClients = payingBusinesses.slice(0, 10);
  const allProblems = listPaymentProblems(revenueSubs);
  const problems = allProblems.slice(0, 20);

  const trendMax = Math.max(...trend.map((p) => p.totalCents), 1);
  const payingCount = payingBusinesses.length;

  // Per-client average uses the per-tenant margin (platform-level costs
  // like the shared campaign fee belong to no single client), while the Net
  // Margin KPI below is the complete fleet figure.
  const avgMarginCents =
    margins !== null && margins.totals.payingBusinesses > 0
      ? Math.round(margins.totals.marginCents / margins.totals.payingBusinesses)
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("revenueTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("revenueSubtitle")}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Est. MRR</p>
          <p className="text-3xl font-bold text-parchment">{formatMoney(mrr.totalCents)}</p>
          <p className="text-xs text-parchment/50 mt-0.5">
            {formatMoney(mrr.committedCents)} committed
            {mrr.refundExposedCents > 0
              ? ` · ${formatMoney(mrr.refundExposedCents)} in refund-window`
              : null}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {formatMoney(mrr.subscriptionCents)} subs · {formatMoney(mrr.enterpriseDealCents)}{" "}
            enterprise
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Net Margin</p>
          {breakdown === null ? (
            <p className="text-3xl font-bold text-parchment/40">—</p>
          ) : (
            <>
              <p
                className={`text-3xl font-bold ${
                  breakdown.netMarginCents >= 0 ? "text-claw-green" : "text-spark-orange"
                }`}
              >
                {formatMoney(breakdown.netMarginCents)}
              </p>
              <p className="text-xs text-parchment/30 mt-1">
                {breakdown.netMarginPct !== null
                  ? `${breakdown.netMarginPct}% of revenue`
                  : "no revenue"}
                {" · "}
                <Link href="/admin/costs" className="hover:text-signal-teal">
                  cost detail
                </Link>
              </p>
            </>
          )}
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Paying Clients</p>
          <p className="text-3xl font-bold text-claw-green">{payingCount}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {mrr.countedSubscriptions} subscriptions · {deals.length} enterprise deals
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">ARPU</p>
          <p className="text-3xl font-bold text-parchment">{formatMoney(arpuCents)}</p>
          <p className="text-xs text-parchment/30 mt-1">
            per paying client / month
            {avgMarginCents !== null && ` · ${formatMoney(avgMarginCents)} avg margin`}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Churn (30d)
          </p>
          <p
            className={`text-3xl font-bold ${
              churn.churnRatePct > 0 ? "text-spark-orange" : "text-parchment"
            }`}
          >
            {churn.churnRatePct}%
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {churn.canceledInWindow} churned of {churn.activeNow + churn.canceledInWindow} at
            period start
          </p>
        </Card>
      </div>

      {/* MRR trend */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          MRR: Last 6 Months
        </h2>
        <div className="flex items-end gap-2 h-32">
          {trend.map((p) => (
            <div key={p.monthKey} className="flex-1 flex flex-col items-center gap-1.5">
              <span className="text-xs text-parchment/50 font-medium">
                {p.totalCents > 0 ? formatMoney(p.totalCents) : ""}
              </span>
              <div className="w-full flex flex-col justify-end" style={{ height: "88px" }}>
                <div
                  className="w-full rounded-t-sm bg-claw-green/60 hover:bg-claw-green transition-colors"
                  style={{
                    height: `${Math.max((p.totalCents / trendMax) * 100, p.totalCents > 0 ? 8 : 0)}%`
                  }}
                />
              </div>
              <span className="text-xs text-parchment/30">{p.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top clients by revenue */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Top Clients by Revenue
          </h2>
          {topClients.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No paying clients yet.</p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {topClients.map((row) => {
                const marginCents = margins?.byBusiness.get(row.businessId)?.marginCents ?? null;
                return (
                  <li
                    key={row.businessId}
                    className="py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <a
                        href={`/admin/${row.businessId}`}
                        className="text-sm text-parchment font-medium hover:text-signal-teal truncate block"
                      >
                        {businessName.get(row.businessId) ?? `${row.businessId.slice(0, 8)}…`}
                      </a>
                      <p className="text-xs text-parchment/30">
                        {formatAdminLabel(row.source)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-sm text-claw-green font-semibold block">
                        {formatMoney(row.cents)}/mo
                      </span>
                      {marginCents !== null && (
                        <span
                          className={`text-xs ${
                            marginCents >= 0 ? "text-parchment/40" : "text-spark-orange"
                          }`}
                        >
                          {formatMoney(marginCents)} margin
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Failed payments / past due */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Payment Problems
            </h2>
            {allProblems.length > 0 && <Badge variant="error">{allProblems.length}</Badge>}
          </div>
          {allProblems.length > problems.length && (
            <p className="text-xs text-parchment/40 mb-2">
              Showing the newest {problems.length} of {allProblems.length}.
            </p>
          )}
          {problems.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">
              No past-due or failed-payment subscriptions.
            </p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {problems.map((p, i) => (
                <li
                  key={`${p.businessId}-${p.kind}-${i}`}
                  className="py-2.5 flex items-center justify-between gap-3"
                >
                  <a
                    href={`/admin/${p.businessId}`}
                    className="text-sm text-parchment hover:text-signal-teal truncate"
                  >
                    {businessName.get(p.businessId) ?? `${p.businessId.slice(0, 8)}…`}
                  </a>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="error">{formatAdminLabel(p.kind)}</Badge>
                    {p.at && (
                      <span className="text-xs text-parchment/30">
                        <LocalDateTime iso={p.at} style="date" />
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
