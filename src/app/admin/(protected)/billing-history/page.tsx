import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  loadBillingHistory,
  seriesOf,
  trendFor,
  vendorCents,
  UNATTRIBUTED_KEY,
  type BillingHistory,
  type BillingHistoryRow
} from "@/lib/admin/billing-history";
import {
  METRICS,
  MONTH_CHOICES,
  barPercent,
  changeTone,
  formatChange,
  formatMetric,
  resolveMetric,
  resolveMonthCount,
  type MetricDef
} from "@/lib/admin/billing-history-view";

export const dynamic = "force-dynamic";

const TONE_CLASS: Record<string, string> = {
  good: "text-claw-green",
  bad: "text-spark-orange",
  flat: "text-parchment/50",
  unknown: "text-parchment/30"
};

function href(params: { metric: string; months: number; business?: string }): string {
  const q = new URLSearchParams({ metric: params.metric, months: String(params.months) });
  if (params.business) q.set("business", params.business);
  return `/admin/billing-history?${q.toString()}`;
}

function TabLink({
  active,
  children,
  to
}: {
  active: boolean;
  children: React.ReactNode;
  to: string;
}) {
  return (
    <a
      href={to}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-signal-teal/20 text-signal-teal"
          : "text-parchment/50 hover:text-parchment border border-parchment/10"
      }`}
    >
      {children}
    </a>
  );
}

/** The fleet (or one tenant's) series for the selected metric, as bars. */
function MonthBars({
  months,
  values,
  metric,
  partial
}: {
  months: string[];
  values: number[];
  metric: MetricDef;
  partial: boolean;
}) {
  const max = Math.max(...values, 0);
  return (
    <div className="flex items-end gap-2 h-36">
      {months.map((month, i) => (
        <div key={month} className="flex-1 flex flex-col items-center gap-1.5">
          <span className="text-xs text-parchment/50 font-medium">
            {formatMetric(values[i]!, metric.format)}
          </span>
          <div className="w-full flex flex-col justify-end" style={{ height: "88px" }}>
            <div
              className={`w-full rounded-t-sm transition-colors ${
                partial && i === months.length - 1
                  ? "bg-signal-teal/25 hover:bg-signal-teal/40"
                  : "bg-signal-teal/60 hover:bg-signal-teal"
              }`}
              style={{ height: `${barPercent(values[i]!, max)}%` }}
            />
          </div>
          <span className="text-xs text-parchment/30">{month.slice(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** A tiny inline bar strip, one bar per month, for a table row. */
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 0);
  return (
    <span className="inline-flex items-end gap-px h-5 align-middle">
      {values.map((v, i) => (
        <span
          key={i}
          className="w-1 rounded-t-sm bg-signal-teal/50"
          style={{ height: `${barPercent(v, max)}%`, minHeight: v > 0 ? "2px" : "1px" }}
        />
      ))}
    </span>
  );
}

function rowLabel(row: BillingHistoryRow): string {
  if (row.business) return row.business.name;
  // Two different things arrive here. Spend that matched no tenant DID is
  // genuinely unattributed; a usage or Gemini row pointing at a business that
  // has left the fleet list is a deleted tenant, and there can be more than
  // one, so it keeps its own id rather than merging into the bucket above.
  if (row.key === UNATTRIBUTED_KEY) return "Unattributed (no tenant matched)";
  return `Deleted tenant ${row.key.slice(0, 8)}`;
}

/** One tenant's full metric grid, shown when a row is opened. */
function TenantDetail({
  history,
  row,
  months
}: {
  history: BillingHistory;
  row: BillingHistoryRow;
  months: number;
}) {
  return (
    <Card>
      <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
        {rowLabel(row)} · every metric · last {months} months
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-parchment/40 text-left">
              <th className="pb-2 font-medium">Metric</th>
              {history.months.map((m) => (
                <th key={m} className="pb-2 font-medium text-right">
                  {m.slice(2)}
                </th>
              ))}
              <th className="pb-2 font-medium text-right">MoM</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-parchment/8">
            {METRICS.map((metric) => {
              const values = seriesOf(row.cells, metric.pick);
              const trend = trendFor(values, {
                partial: history.newestMonthIsPartial,
                elapsed: history.newestMonthElapsed
              });
              return (
                <tr key={metric.key}>
                  <td className="py-2 text-parchment/70">{metric.label}</td>
                  {values.map((v, i) => (
                    <td key={i} className="py-2 text-right text-parchment/70">
                      {formatMetric(v, metric.format)}
                    </td>
                  ))}
                  <td
                    className={`py-2 text-right font-semibold ${
                      TONE_CLASS[changeTone(trend.changePct, metric.upIsBad)]
                    }`}
                  >
                    {formatChange(trend.changePct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-parchment/30 mt-3">
        MoM compares the newest month against the one before it. While a month is still running
        the newest column is pro-rated to a full month first, so a live month is not read as a
        collapse.
      </p>
    </Card>
  );
}

export default async function AdminBillingHistoryPage({
  searchParams
}: {
  searchParams: Promise<{ metric?: string; months?: string; business?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const { metric: metricParam, months: monthsParam, business: businessParam } = await searchParams;
  const metric = resolveMetric(metricParam);
  const monthCount = resolveMonthCount(monthsParam);

  const history = await loadBillingHistory({ months: monthCount });
  const trendOpts = {
    partial: history.newestMonthIsPartial,
    elapsed: history.newestMonthElapsed
  };

  const fleetValues = seriesOf(history.fleet, metric.pick);
  const fleetTrend = trendFor(fleetValues, trendOpts);
  const fleetRevenue = trendFor(seriesOf(history.fleet, (c) => c.revenueCents), trendOpts);
  const fleetVendor = trendFor(seriesOf(history.fleet, vendorCents), trendOpts);

  const selected = history.rows.find((r) => r.key === businessParam) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("billingHistoryTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("billingHistorySubtitle")}</p>
        </div>
        <div className="flex items-center gap-1">
          {MONTH_CHOICES.map((n) => (
            <TabLink
              key={n}
              active={n === monthCount}
              to={href({ metric: metric.key, months: n, business: businessParam })}
            >
              {n}m
            </TabLink>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {METRICS.map((m) => (
          <TabLink
            key={m.key}
            active={m.key === metric.key}
            to={href({ metric: m.key, months: monthCount, business: businessParam })}
          >
            {m.label}
          </TabLink>
        ))}
      </div>

      {/* Headline trends */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            {metric.label} · this month
          </p>
          <p className="text-3xl font-bold text-parchment">
            {formatMetric(fleetTrend.current, metric.format)}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            vs {formatMetric(fleetTrend.previous, metric.format)} last month
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            {metric.label} · projected
          </p>
          <p
            className={`text-3xl font-bold ${
              TONE_CLASS[changeTone(fleetTrend.changePct, metric.upIsBad)]
            }`}
          >
            {formatMetric(fleetTrend.projected, metric.format)}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {formatChange(fleetTrend.changePct)}{" "}
            {history.newestMonthIsPartial
              ? `· ${Math.round(history.newestMonthElapsed * 100)}% of the month elapsed`
              : "· month complete"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Revenue · projected
          </p>
          <p className="text-3xl font-bold text-claw-green">
            {formatMetric(fleetRevenue.projected, "money")}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {formatChange(fleetRevenue.changePct)} vs last month
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Vendor cost · projected
          </p>
          <p className="text-3xl font-bold text-parchment">
            {formatMetric(fleetVendor.projected, "money")}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {formatChange(fleetVendor.changePct)} · Telnyx + Gemini only
          </p>
        </Card>
      </div>

      {/* Fleet chart */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          All tenants · {metric.label} by month
        </h2>
        <MonthBars
          months={history.months}
          values={fleetValues}
          metric={metric}
          partial={history.newestMonthIsPartial}
        />
        <p className="text-xs text-parchment/30 mt-3">
          The last bar is dimmed while its month is still running. Hosting is not in any figure on
          this page: the Hostinger snapshot is replaced on every sync and keeps no history, so
          there is no honest per-month hosting number to show. See{" "}
          <Link href="/admin/costs" className="hover:text-signal-teal underline">
            Costs
          </Link>{" "}
          for the current month&apos;s full breakdown.
        </p>
      </Card>

      {/* Per-tenant */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Per tenant · {metric.label}
        </h2>
        {history.rows.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            Nothing metered in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Business</th>
                  <th className="pb-2 font-medium">Trend</th>
                  {history.months.map((m) => (
                    <th key={m} className="pb-2 font-medium text-right">
                      {m.slice(2)}
                    </th>
                  ))}
                  <th className="pb-2 font-medium text-right">MoM</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {history.rows.map((row) => {
                  const values = seriesOf(row.cells, metric.pick);
                  const trend = trendFor(values, trendOpts);
                  return (
                    <tr key={row.key}>
                      <td className="py-2">
                        <a
                          href={href({
                            metric: metric.key,
                            months: monthCount,
                            business: row.key
                          })}
                          className="text-parchment font-medium hover:text-signal-teal"
                        >
                          {rowLabel(row)}
                        </a>
                        {row.business ? (
                          <Badge variant="neutral" className="ml-2 capitalize">
                            {row.business.tier}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="py-2">
                        <Sparkline values={values} />
                      </td>
                      {values.map((v, i) => (
                        <td key={i} className="py-2 text-right text-parchment/70">
                          {formatMetric(v, metric.format)}
                        </td>
                      ))}
                      <td
                        className={`py-2 text-right font-semibold ${
                          TONE_CLASS[changeTone(trend.changePct, metric.upIsBad)]
                        }`}
                      >
                        {formatChange(trend.changePct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-parchment/30 mt-3">
          Sorted by this month&apos;s vendor spend. Click a tenant to see every metric for it.
          &quot;Text units&quot; is what the carrier and the plan cap actually bill (one unit per
          message part); &quot;Messages&quot; is the message count, so a four-part text counts once
          there and four times in units.
        </p>
      </Card>

      {selected ? (
        <TenantDetail history={history} row={selected} months={monthCount} />
      ) : null}
    </div>
  );
}
