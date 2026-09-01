import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { getTranslations } from "next-intl/server";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  parsePlatformCostSyncStatus
} from "@/lib/admin/cost-sync";
import { loadFleetCostBreakdown, trendWindowStartYmd } from "@/lib/admin/fleet-cost";
import {
  TELNYX_SERIES_OTHER,
  TELNYX_SERIES_UNATTRIBUTED,
  TELNYX_USAGE_WINDOW_KEYS,
  buildPoolBoxBurn,
  buildRenewalCalendar,
  buildTelnyxDailySeries,
  buildTelnyxTenantWindowBreakdown,
  buildUnattributedSenders,
  fleetMonthlyTotal,
  resolveTelnyxUsageWindowKey,
  telnyxDirectionSummary,
  telnyxMonthlyTrend,
  telnyxUsageWindow,
  type TelnyxUsageWindowKey
} from "@/lib/admin/costs-view";
import {
  fetchTelnyxAutoRechargePrefs,
  fetchTelnyxBalance,
  formatAutoRechargeLine
} from "@/lib/telnyx/balance";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import {
  MARGIN_ALERT_SETTINGS_KEY,
  parseMarginAlertConfig
} from "@/lib/admin/margin-alert";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { CostSyncButton } from "@/components/admin/CostSyncButton";
import { MarginAlertSettings } from "@/components/admin/MarginAlertSettings";
import { boxTermState, boxTermEndsAt, cycleContradictsNextBilling } from "@/lib/vps/box-term";
import { billingCycleMonths } from "@/lib/admin/cost-sync";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function microsToMoney(micros: number): string {
  return money(micros / 10_000);
}

const WINDOW_LABELS: Record<TelnyxUsageWindowKey, string> = {
  "7d": "7 days",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days"
};

// Tenant stack colors by window-spend rank. Spark-orange stays reserved for
// the Unattributed bucket so it reads as the same leak signal as the cost
// split above.
const TENANT_SEGMENT_CLASSES = [
  "bg-signal-teal/80",
  "bg-claw-green/70",
  "bg-parchment/50",
  "bg-signal-teal/40",
  "bg-claw-green/40",
  "bg-parchment/25",
  "bg-signal-teal/20"
];
const OTHER_SEGMENT_CLASS = "bg-parchment/10";
const UNATTRIBUTED_SEGMENT_CLASS = "bg-spark-orange/70";

export default async function AdminCostsPage({
  searchParams
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const now = new Date();
  const { window: windowParam } = await searchParams;
  const windowKey = resolveTelnyxUsageWindowKey(windowParam);
  const usageWindow = telnyxUsageWindow(windowKey, now);
  // One shared load: the fleet cost breakdown every admin surface renders,
  // plus the raw rows this page's per-window views need. Its 90d Telnyx
  // fetch also covers every selectable per-tenant usage window, since
  // trendWindowStartYmd (instant now minus 90d) always starts at or before
  // the widest window's UTC-floor(now) minus 89 days.
  const telnyxKey = process.env.TELNYX_API_KEY?.trim() || null;
  const [fleetCost, syncStatusRaw, balance, autoRecharge] = await Promise.all([
    loadFleetCostBreakdown(now),
    getAdminPlatformSetting(PLATFORM_COST_SYNC_STATUS_KEY).catch(() => null),
    fetchTelnyxBalance(telnyxKey),
    fetchTelnyxAutoRechargePrefs(telnyxKey)
  ]);
  const { margins, hostingerRows, telnyxTrendRows, inventory, breakdown } = fleetCost;

  const syncStatus = parsePlatformCostSyncStatus(syncStatusRaw);
  const marginAlertConfig = parseMarginAlertConfig(
    await getAdminPlatformSetting(MARGIN_ALERT_SETTINGS_KEY).catch(() => null)
  );

  // Every figure below comes from the shared model (src/lib/admin/fleet-cost.ts)
  // so this page, the Dashboard and the Revenue page cannot disagree about
  // what the fleet costs. Leak spend, idle-pool hosting, the shared 10DLC
  // campaign fee, the voice adjunct estimate and Telnyx taxes are real
  // platform cost no tenant's margin can see; the model folds them in so
  // the KPI reconciles with the vendor invoice.
  const lineTotals = breakdown.perTenantCents;
  const monthTelnyxRows = telnyxTrendRows.filter((r) => r.day >= margins.monthStartYmd);
  // Micros for the per-sender display (it reports sub-cent amounts); the
  // rolled-up leak TOTAL comes from the shared model below, so this page's
  // KPI cannot drift from the Dashboard's and the Revenue page's.
  const unattributedMonthMicros = monthTelnyxRows
    .filter((r) => r.business_id === null)
    .reduce((sum, r) => sum + r.cost_micros, 0);
  const unattributedSenders = buildUnattributedSenders(monthTelnyxRows);
  const poolBurn = buildPoolBoxBurn({ inventory, hostingerRows, now });
  const unattributedMonthCents = breakdown.unattributedTelnyxCents;
  const poolBurnMonthlyCents = breakdown.poolHostingCents;
  const voiceAdjunctMonthCents = breakdown.voiceAdjunctCents;
  const telnyxTaxMonthCents = breakdown.telnyxTaxCents;
  const totalCostCents = breakdown.totalCostCents;
  const netMarginCents = breakdown.netMarginCents;
  const netMarginPct = breakdown.netMarginPct;

  const trend = telnyxMonthlyTrend(telnyxTrendRows);
  const trendMax = Math.max(...trend.map((p) => p.costMicros), 1);
  const directions = telnyxDirectionSummary(monthTelnyxRows);

  const businessNames = new Map(margins.businesses.map((b) => [b.id, b.name]));

  // Windowed per-tenant Telnyx burn (the "who used it since the reload" view).
  const usageSeries = buildTelnyxDailySeries(telnyxTrendRows, usageWindow);
  const usageBreakdown = buildTelnyxTenantWindowBreakdown(telnyxTrendRows, usageWindow);
  const seriesClassByKey = new Map<string, string>();
  let tenantRank = 0;
  for (const entry of usageSeries.series) {
    seriesClassByKey.set(
      entry.seriesKey,
      entry.seriesKey === TELNYX_SERIES_UNATTRIBUTED
        ? UNATTRIBUTED_SEGMENT_CLASS
        : entry.seriesKey === TELNYX_SERIES_OTHER
          ? OTHER_SEGMENT_CLASS
          : TENANT_SEGMENT_CLASSES[Math.min(tenantRank++, TENANT_SEGMENT_CLASSES.length - 1)]
    );
  }
  const seriesLabel = (key: string): string =>
    key === TELNYX_SERIES_OTHER
      ? "Other tenants"
      : key === TELNYX_SERIES_UNATTRIBUTED
        ? "Unattributed"
        : (businessNames.get(key) ?? `${key.slice(0, 8)}…`);
  // The loader's active-preferring subscription map, so a pending
  // resubscribe row can't hide a live contract from the calendar.
  const renewalEvents = buildRenewalCalendar({
    hostingerRows,
    subscriptions: [...margins.subscriptionByBusiness.values()],
    businessNames,
    now
  });
  // Hostinger fleet monthly total: every non-cancelled subscription's
  // effective monthly price (assigned + pooled; cancelled rows are gone
  // money, not recurring spend). A box whose price the sync withheld falls
  // back to its SKU estimate rather than counting as zero, and the card says
  // how many did, so the headline is never read as fully synced.
  const hostingerTotal = fleetMonthlyTotal(hostingerRows);

  // Gemini: top current-period chat spenders vs their tier cap.
  const tierById = new Map(margins.businesses.map((b) => [b.id, b.tier]));
  const geminiSpenders = [...margins.aiSpendMicrosByBusiness.entries()]
    .map(([businessId, spendMicros]) => ({
      businessId,
      spendMicros,
      capMicros: chatSpendBaseCapMicrosForTier(tierById.get(businessId) ?? null)
    }))
    .sort((a, b) => b.spendMicros - a.spendMicros)
    .slice(0, 8);
  const geminiFleetMicros = [...margins.aiSpendMicrosByBusiness.values()].reduce(
    (sum, v) => sum + v,
    0
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("costsTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("costsSubtitle")}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {syncStatus ? (
              <>
                Last synced <LocalDateTime iso={syncStatus.lastSyncAt} style="detail" /> ·{" "}
                {syncStatus.ok ? (
                  "OK"
                ) : (
                  <span className="text-spark-orange">
                    {syncStatus.telnyxError ??
                      syncStatus.hostingerError ??
                      syncStatus.stripeError ??
                      "finished with errors"}
                  </span>
                )}
              </>
            ) : (
              "Never synced: run a Sync now + Backfill 90d after first deploy."
            )}
          </p>
        </div>
        <CostSyncButton />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Est. Monthly Cost
          </p>
          <p className="text-3xl font-bold text-parchment">{money(totalCostCents)}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {money(lineTotals.hosting)} hosting · {money(lineTotals.telnyx_usage)} Telnyx ·{" "}
            {money(lineTotals.gemini_chat)} Gemini
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Net Margin / Mo
          </p>
          <p
            className={`text-3xl font-bold ${
              netMarginCents >= 0 ? "text-claw-green" : "text-spark-orange"
            }`}
          >
            {money(netMarginCents)}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            on {money(margins.totals.revenueCents)} revenue
            {netMarginPct !== null && ` · ${netMarginPct}%`}
            {(unattributedMonthCents > 0 || poolBurnMonthlyCents > 0) &&
              " · incl. leak + pool spend"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Telnyx Balance
          </p>
          <p className="text-3xl font-bold text-parchment">
            {balance ? `$${balance.balanceUsd.toFixed(2)}` : "-"}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {balance
              ? `${balance.currency}${balance.pendingUsd !== null ? ` · $${balance.pendingUsd.toFixed(2)} pending` : ""}`
              : "live read unavailable"}
            {autoRecharge ? ` · ${formatAutoRechargeLine(autoRecharge)}` : ""}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Hostinger Fleet / Mo
          </p>
          <p className="text-3xl font-bold text-parchment">{money(hostingerTotal.cents)}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {hostingerRows.length} billing subs · {money(poolBurnMonthlyCents)} idle-pool burn
            {hostingerTotal.estimatedRows > 0
              ? ` · ${hostingerTotal.estimatedRows} at SKU estimate`
              : ""}
            {hostingerTotal.unpricedRows > 0
              ? ` · ${hostingerTotal.unpricedRows} unpriced`
              : ""}
          </p>
        </Card>
      </div>

      {/* Cost split by line */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          This Month&apos;s Cost Split{" "}
          {margins.telnyxActuals ? "(Telnyx actuals)" : "(estimates: sync has no data yet)"}
        </h2>
        <div className="space-y-2">
          {(
            [
              ["Hosting (Hostinger)", lineTotals.hosting],
              ["Telnyx usage", lineTotals.telnyx_usage],
              ["Phone number rentals", lineTotals.did],
              ["Gemini (metered, incl. Live voice)", lineTotals.gemini_chat],
              [
                margins.stripeActuals
                  ? "Stripe fees (observed rate)"
                  : "Stripe fees (est. from card region)",
                lineTotals.stripe_fees
              ],
              ["10DLC campaign fee", breakdown.campaignFeeCents],
              ["Voice API adjuncts (est.)", voiceAdjunctMonthCents],
              ["Telnyx taxes (est.)", telnyxTaxMonthCents],
              ["Idle pool hosting", poolBurnMonthlyCents],
              ["Telnyx unattributed (leak check)", unattributedMonthCents],
              ["Stripe outside tenant lines (disputes, account level)", breakdown.unmodeledStripeFeeCents]
            ] as const
          ).map(([label, cents]) => {
            const pct = totalCostCents > 0 ? Math.round((cents / totalCostCents) * 100) : 0;
            return (
              <div key={label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-parchment/70">{label}</span>
                  <span className="text-parchment/40">
                    {money(cents)} · {pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-parchment/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      label.startsWith("Telnyx unattributed") && cents > 0
                        ? "bg-spark-orange"
                        : "bg-signal-teal/70"
                    }`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {unattributedMonthMicros > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-xs text-spark-orange/80">
              {microsToMoney(unattributedMonthMicros)} of Telnyx spend this month matched no tenant
              DID. Senders labeled below are platform senders and can never match one; anything
              unlabeled is a leaked number worth chasing.
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
              {unattributedSenders.map((entry) => (
                <li key={entry.sender ?? "unnamed"} className="text-xs text-parchment/50">
                  <span className="font-mono text-parchment/70">
                    {entry.sender ?? "sender not recorded"}
                  </span>{" "}
                  {microsToMoney(entry.costMicros)} · {entry.recordCount.toLocaleString("en-US")}{" "}
                  rec ·{" "}
                  {entry.platformLabel ? (
                    <span className="text-parchment/40">{entry.platformLabel}</span>
                  ) : (
                    <span className="text-spark-orange/80">worth chasing</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

        )}
      </Card>

      {/* Telnyx monthly trend */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Telnyx Cost by Month (synced window)
        </h2>
        {trend.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No synced Telnyx records yet: run Backfill 90d.
          </p>
        ) : (
          <div className="flex items-end gap-2 h-32">
            {trend.map((p) => (
              <div key={p.month} className="flex-1 flex flex-col items-center gap-1.5">
                <span className="text-xs text-parchment/50 font-medium">
                  {microsToMoney(p.costMicros)}
                </span>
                <div className="w-full flex flex-col justify-end" style={{ height: "88px" }}>
                  <div
                    className="w-full rounded-t-sm bg-signal-teal/60 hover:bg-signal-teal transition-colors"
                    style={{
                      height: `${Math.max((p.costMicros / trendMax) * 100, p.costMicros > 0 ? 8 : 0)}%`
                    }}
                  />
                </div>
                <span className="text-xs text-parchment/30">{p.month}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Telnyx per-tenant burn, windowed */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Telnyx Usage by Tenant
            </h2>
            <p className="text-xs text-parchment/30 mt-1">
              {usageWindow.startYmd} → {usageWindow.endYmdExclusive} (UTC days) ·{" "}
              {microsToMoney(usageBreakdown.totalMicros)} total
            </p>
            <p className="text-xs text-parchment/30 mt-1">
              Usage only (detail records). Number rental posts on the 1st and the 10DLC
              campaign fee posts on the 6th; those still drain the prepaid balance and
              can fire auto-recharge even when this chart is quiet.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {TELNYX_USAGE_WINDOW_KEYS.map((key) => (
              <a
                key={key}
                href={`/admin/costs?window=${key}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  key === windowKey
                    ? "bg-signal-teal/20 text-signal-teal"
                    : "text-parchment/50 hover:text-parchment border border-parchment/10"
                }`}
              >
                {WINDOW_LABELS[key]}
              </a>
            ))}
          </div>
        </div>
        {usageSeries.totalMicros === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No synced Telnyx spend in this window. Run Sync now, or Backfill 90d to fill history.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-1 h-36">
              {usageSeries.points.map((point) => (
                <div
                  key={point.day}
                  className="flex-1 flex flex-col justify-end h-full min-w-0"
                  title={`${point.day} · ${microsToMoney(point.costMicros)}${point.segments
                    .map((s) => `\n${seriesLabel(s.seriesKey)}: ${microsToMoney(s.costMicros)}`)
                    .join("")}`}
                >
                  {/* Visibility floor applies ONCE to the whole column, never
                      per segment (per-segment floors would compound and
                      inflate days with many small tenants); segments then
                      split the column exactly proportionally. */}
                  {point.costMicros > 0 && (
                    <div
                      className="w-full flex flex-col"
                      style={{
                        height: `${Math.max((point.costMicros / usageSeries.maxMicros) * 100, 1.5)}%`
                      }}
                    >
                      {point.segments.map((segment) => (
                        <div
                          key={segment.seriesKey}
                          className={`w-full ${seriesClassByKey.get(segment.seriesKey) ?? OTHER_SEGMENT_CLASS}`}
                          style={{
                            height: `${(segment.costMicros / point.costMicros) * 100}%`
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-parchment/30 mt-2">
              <span>{usageSeries.points[0]?.day}</span>
              <span>{usageSeries.points[usageSeries.points.length - 1]?.day}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
              {usageSeries.series.map((entry) => (
                <span key={entry.seriesKey} className="flex items-center gap-1.5 text-xs">
                  <span
                    className={`inline-block h-2 w-2 rounded-sm ${seriesClassByKey.get(entry.seriesKey)}`}
                  />
                  <span className="text-parchment/60">{seriesLabel(entry.seriesKey)}</span>
                </span>
              ))}
            </div>
          </>
        )}
        {usageBreakdown.hasRows && (
          <div className="mobile-scroll-x mt-4">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Tenant</th>
                  <th className="pb-2 font-medium text-right">SMS</th>
                  <th className="pb-2 font-medium text-right">SMS cost</th>
                  <th className="pb-2 font-medium text-right">Voice</th>
                  <th className="pb-2 font-medium text-right">Voice cost</th>
                  <th className="pb-2 font-medium text-right">Carrier fees</th>
                  <th className="pb-2 font-medium text-right">Total</th>
                  <th className="pb-2 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {usageBreakdown.tenants.map((row) => (
                  <tr key={row.businessId ?? "unattributed"}>
                    <td className="py-2">
                      {row.businessId !== null ? (
                        <a
                          href={`/admin/${row.businessId}`}
                          className="text-parchment hover:text-signal-teal"
                        >
                          {businessNames.get(row.businessId) ?? `${row.businessId.slice(0, 8)}…`}
                        </a>
                      ) : (
                        <span className="text-spark-orange">Unattributed</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {row.messagingCount.toLocaleString("en-US")} msgs
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {microsToMoney(row.messagingMicros)}
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {row.voiceMinutes.toFixed(1)} min
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {microsToMoney(row.voiceMicros)}
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {microsToMoney(row.carrierFeeMicros)}
                    </td>
                    <td className="py-2 text-right text-parchment font-medium">
                      {microsToMoney(row.totalMicros)}
                    </td>
                    <td className="py-2 text-right text-parchment/60">{row.sharePct ?? 0}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-parchment/30 mt-3">
          Attribution matches each Telnyx record&apos;s number to a tenant DID. Unattributed spend
          matched no tenant DID: platform traffic, a leaked number, or a deleted tenant. Days sync
          on a rolling 7-day window; if the sync was down for a stretch, run Backfill 90d to fill
          gaps.
        </p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Telnyx by direction */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Telnyx This Month, by Type + Direction
          </h2>
          {directions.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No synced rows this month.</p>
          ) : (
            <div className="mobile-scroll-x">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Type / direction</th>
                  <th className="pb-2 font-medium text-right">Volume</th>
                  <th className="pb-2 font-medium text-right">Carrier fees</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {directions.map((d) => (
                  <tr key={`${d.recordType}-${d.direction}`}>
                    <td className="py-2 text-parchment/80">
                      {d.recordType === "messaging" ? "SMS" : "Voice"} · {d.direction}
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {d.recordType === "messaging"
                        ? `${d.records.toLocaleString("en-US")} msgs`
                        : `${d.voiceMinutes.toFixed(1)} min`}
                    </td>
                    <td className="py-2 text-right text-parchment/60">
                      {microsToMoney(d.carrierFeeMicros)}
                    </td>
                    <td className="py-2 text-right text-parchment font-medium">
                      {microsToMoney(d.costMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Card>

        {/* Gemini spend */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Gemini Chat Spend (current periods)
          </h2>
          <p className="text-2xl font-bold text-parchment mb-3">
            {microsToMoney(geminiFleetMicros)}
            <span className="text-xs text-parchment/40 font-normal ml-2">fleet, metered</span>
          </p>
          {geminiSpenders.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No spend this period.</p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {geminiSpenders.map((s) => {
                const pct = Math.round((s.spendMicros / s.capMicros) * 100);
                return (
                  <li key={s.businessId} className="py-2 flex items-center justify-between gap-3">
                    <a
                      href={`/admin/${s.businessId}`}
                      className="text-xs text-parchment hover:text-signal-teal truncate"
                    >
                      {businessNames.get(s.businessId) ?? `${s.businessId.slice(0, 8)}…`}
                    </a>
                    <span className="text-xs shrink-0">
                      <span className="text-parchment/70">{microsToMoney(s.spendMicros)}</span>
                      <span
                        className={`ml-2 ${pct >= 80 ? "text-spark-orange" : "text-parchment/40"}`}
                      >
                        {pct}% of cap
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Hostinger fleet table */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Hostinger Fleet (synced billing subscriptions)
        </h2>
        {hostingerRows.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No snapshot yet: run Sync now.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Box</th>
                  <th className="pb-2 font-medium">Plan</th>
                  <th className="pb-2 font-medium">Tenant</th>
                  <th className="pb-2 font-medium text-right">Eff. $/mo</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Renews / expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {hostingerRows.map((row) => {
                  // Same two helpers the per-tenant Infrastructure card
                  // renders from, so the fleet table and the tenant page can
                  // never disagree about when a box dies.
                  const state = boxTermState(row);
                  const notRenewing = state !== "renewing";
                  const at = boxTermEndsAt(row);
                  // The sync blanks monthly_price_cents when the declared
                  // cycle cannot explain the next billing date, because both
                  // the cycle and the price Hostinger quotes are stale then.
                  // A bare "-" would read as "no data"; this is the opposite,
                  // we have data and know it is wrong, so name it.
                  const cycleStale = cycleContradictsNextBilling(
                    billingCycleMonths(row.billing_period, row.billing_period_unit),
                    row.next_billing_at
                  );
                  return (
                    <tr key={row.subscription_id}>
                      <td className="py-2 font-mono text-parchment/80">
                        {row.hostname ?? (row.vm_id !== null ? `VM ${row.vm_id}` : "-")}
                      </td>
                      <td className="py-2 text-parchment/60 uppercase">{row.plan ?? "-"}</td>
                      <td className="py-2">
                        {row.assigned_business_id ? (
                          <a
                            href={`/admin/${row.assigned_business_id}`}
                            className="text-parchment hover:text-signal-teal"
                          >
                            {businessNames.get(row.assigned_business_id) ??
                              `${row.assigned_business_id.slice(0, 8)}…`}
                          </a>
                        ) : (
                          <span className="text-parchment/40">unassigned</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-parchment font-medium">
                        {row.monthly_price_cents !== null ? (
                          money(row.monthly_price_cents)
                        ) : cycleStale ? (
                          <span
                            className="text-spark-orange"
                            title={
                              "Hostinger moved this subscription's next billing date without " +
                              "updating its period or price, so no monthly cost can be derived. " +
                              "Margin falls back to the SKU estimate. Read the real amount off " +
                              "the hPanel invoice."
                            }
                          >
                            term changed
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-2">
                        <Badge variant={notRenewing ? "pending" : "success"}>
                          {state}
                        </Badge>
                      </td>
                      <td className="py-2 text-parchment/60">
                        {at ? <LocalDateTime iso={at} style="date" /> : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Renewal calendar */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Renewal Calendar (next 90 days)
          </h2>
          {renewalEvents.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">
              Nothing renews, lapses, or rolls over in the next 90 days.
            </p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {renewalEvents.map((event, i) => (
                <li key={`${event.kind}-${event.at}-${i}`} className="py-2.5 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        event.kind === "term_rollover"
                          ? "success"
                          : event.kind === "hostinger_lapse"
                            ? "error"
                            : "neutral"
                      }
                    >
                      {event.kind === "term_rollover"
                        ? "rollover"
                        : event.kind === "hostinger_lapse"
                          ? "lapse"
                          : "renewal"}
                    </Badge>
                    <span className="text-xs text-parchment font-medium">{event.label}</span>
                    <span className="text-xs text-parchment/30 ml-auto shrink-0">
                      in {event.daysAway}d · <LocalDateTime iso={event.at} style="date" />
                    </span>
                  </div>
                  <p className="text-xs text-parchment/50">
                    {event.detail}
                    {event.monthlyCents !== null &&
                      ` · ${money(Math.abs(event.monthlyCents))}/mo ${
                        event.kind === "term_rollover" ? "rate upside" : "spend"
                      }`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Pool box burn + margin watchdog */}
        <div className="space-y-4">
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Idle Pool Burn
          </h2>
          {poolBurn.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">
              No idle pooled boxes: nothing rents while serving nobody.
            </p>
          ) : (
            <ul className="divide-y divide-parchment/8">
              {poolBurn.map((box) => (
                <li key={box.vmId} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-parchment font-mono truncate">
                      {box.hostname ?? `VM ${box.vmId}`}{" "}
                      <span className="text-parchment/40 uppercase">{box.plan}</span>
                    </p>
                    <p className="text-xs text-parchment/40">
                      {box.autoRenew === true
                        ? "auto-renewing while idle"
                        : box.endsAt
                          ? "lapses"
                          : "billing unknown"}
                      {box.endsAt && (
                        <>
                          {" "}
                          <LocalDateTime iso={box.endsAt} style="date" />
                          {box.daysLeft !== null && ` (${box.daysLeft}d)`}
                        </>
                      )}
                    </p>
                  </div>
                  <span className="text-xs text-spark-orange font-semibold shrink-0">
                    {box.monthlyCents !== null ? `${money(box.monthlyCents)}/mo` : "-"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <MarginAlertSettings initialConfig={marginAlertConfig} />
        </div>
      </div>
    </div>
  );
}
