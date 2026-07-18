import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { getTranslations } from "next-intl/server";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  parsePlatformCostSyncStatus
} from "@/lib/admin/cost-sync";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import {
  buildPoolBoxBurn,
  buildRenewalCalendar,
  sumMarginLinesByKey,
  telnyxDirectionSummary,
  telnyxMonthlyTrend
} from "@/lib/admin/costs-view";
import { listHostingerVpsCosts, listTelnyxCostDaily } from "@/lib/db/platform-costs";
import { listVpsInventory } from "@/lib/db/vps-inventory";
import { fetchTelnyxBalance } from "@/lib/telnyx/balance";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import { logger } from "@/lib/logger";
import {
  MARGIN_ALERT_SETTINGS_KEY,
  parseMarginAlertConfig
} from "@/lib/admin/margin-alert";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { CostSyncButton } from "@/components/admin/CostSyncButton";
import { MarginAlertSettings } from "@/components/admin/MarginAlertSettings";

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

function trendWindowStartYmd(now: Date): string {
  const d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export default async function AdminCostsPage() {
  const t = await getTranslations("admin.pages");
  const now = new Date();
  const [margins, syncStatusRaw, hostingerRows, telnyxTrendRows, inventory, balance] =
    await Promise.all([
      loadFleetMargins(now),
      getAdminPlatformSetting(PLATFORM_COST_SYNC_STATUS_KEY).catch(() => null),
      listHostingerVpsCosts().catch((err: unknown) => {
        logger.error("admin costs: hostinger snapshot read failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return [];
      }),
      listTelnyxCostDaily(trendWindowStartYmd(new Date())).catch((err: unknown) => {
        logger.error("admin costs: telnyx trend read failed", {
          message: err instanceof Error ? err.message : String(err)
        });
        return [];
      }),
      listVpsInventory().catch(() => []),
      fetchTelnyxBalance(process.env.TELNYX_API_KEY?.trim() || null)
    ]);

  const syncStatus = parsePlatformCostSyncStatus(syncStatusRaw);
  const marginAlertConfig = parseMarginAlertConfig(
    await getAdminPlatformSetting(MARGIN_ALERT_SETTINGS_KEY).catch(() => null)
  );

  const lineTotals = sumMarginLinesByKey(margins.economics);
  const monthTelnyxRows = telnyxTrendRows.filter((r) => r.day >= margins.monthStartYmd);
  const unattributedMonthMicros = monthTelnyxRows
    .filter((r) => r.business_id === null)
    .reduce((sum, r) => sum + r.cost_micros, 0);
  const unattributedMonthCents = Math.round(unattributedMonthMicros / 10_000);
  const poolBurn = buildPoolBoxBurn({ inventory, hostingerRows, now });
  const poolBurnMonthlyCents = poolBurn.reduce((sum, b) => sum + (b.monthlyCents ?? 0), 0);
  // Leak spend and idle-pool hosting are real platform cost the per-tenant
  // margin sums never see: fold both into the KPI cost + net figures so
  // they reconcile with the vendor numbers on this same page.
  const totalCostCents =
    margins.totals.costCents + unattributedMonthCents + poolBurnMonthlyCents;
  const netMarginCents =
    margins.totals.marginCents - unattributedMonthCents - poolBurnMonthlyCents;
  const netMarginPct =
    margins.totals.revenueCents > 0
      ? Math.round((netMarginCents / margins.totals.revenueCents) * 1000) / 10
      : null;

  const trend = telnyxMonthlyTrend(telnyxTrendRows);
  const trendMax = Math.max(...trend.map((p) => p.costMicros), 1);
  const directions = telnyxDirectionSummary(monthTelnyxRows);

  const businessNames = new Map(margins.businesses.map((b) => [b.id, b.name]));
  // The loader's active-preferring subscription map, so a pending
  // resubscribe row can't hide a live contract from the calendar.
  const renewalEvents = buildRenewalCalendar({
    hostingerRows,
    subscriptions: [...margins.subscriptionByBusiness.values()],
    businessNames,
    now
  });
  // Hostinger fleet monthly total: every non-cancelled subscription's
  // effective monthly price (assigned + pooled — cancelled rows are gone
  // money, not recurring spend).
  const hostingerMonthlyTotal = hostingerRows
    .filter((r) => r.status !== "cancelled")
    .reduce((sum, r) => sum + (r.monthly_price_cents ?? 0), 0);

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
                    {syncStatus.telnyxError ?? syncStatus.hostingerError ?? "finished with errors"}
                  </span>
                )}
              </>
            ) : (
              "Never synced — run a Sync now + Backfill 90d after first deploy."
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
            {balance ? `$${balance.balanceUsd.toFixed(2)}` : "—"}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {balance
              ? `${balance.currency}${balance.pendingUsd !== null ? ` · $${balance.pendingUsd.toFixed(2)} pending` : ""}`
              : "live read unavailable"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Hostinger Fleet / Mo
          </p>
          <p className="text-3xl font-bold text-parchment">{money(hostingerMonthlyTotal)}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {hostingerRows.length} billing subs · {money(poolBurnMonthlyCents)} idle-pool burn
          </p>
        </Card>
      </div>

      {/* Cost split by line */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          This Month&apos;s Cost Split{" "}
          {margins.telnyxActuals ? "(Telnyx actuals)" : "(estimates — sync has no data yet)"}
        </h2>
        <div className="space-y-2">
          {(
            [
              ["Hosting (Hostinger)", lineTotals.hosting],
              ["Telnyx usage", lineTotals.telnyx_usage],
              ["Phone number rentals", lineTotals.did],
              ["Gemini (metered, incl. Live voice)", lineTotals.gemini_chat],
              ["Stripe fees", lineTotals.stripe_fees],
              ["Idle pool hosting", poolBurnMonthlyCents],
              ["Telnyx unattributed (leak check)", unattributedMonthCents]
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
          <p className="text-xs text-spark-orange/80 mt-3">
            {microsToMoney(unattributedMonthMicros)} of Telnyx spend this month matched no tenant
            DID — check for leaked numbers or platform traffic.
          </p>
        )}
      </Card>

      {/* Telnyx monthly trend */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Telnyx Cost by Month (synced window)
        </h2>
        {trend.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No synced Telnyx records yet — run Backfill 90d.
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Telnyx by direction */}
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Telnyx This Month, by Type + Direction
          </h2>
          {directions.length === 0 ? (
            <p className="text-sm text-parchment/40 text-center py-4">No synced rows this month.</p>
          ) : (
            <table className="w-full text-xs">
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
            No snapshot yet — run Sync now.
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
                  const notRenewing =
                    row.is_auto_renewed === false ||
                    row.status === "non_renewing" ||
                    row.status === "cancelled";
                  const at = notRenewing
                    ? (row.expires_at ?? row.next_billing_at)
                    : row.next_billing_at;
                  return (
                    <tr key={row.subscription_id}>
                      <td className="py-2 font-mono text-parchment/80">
                        {row.hostname ?? (row.vm_id !== null ? `VM ${row.vm_id}` : "—")}
                      </td>
                      <td className="py-2 text-parchment/60 uppercase">{row.plan ?? "—"}</td>
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
                        {row.monthly_price_cents !== null ? money(row.monthly_price_cents) : "—"}
                      </td>
                      <td className="py-2">
                        <Badge variant={notRenewing ? "pending" : "success"}>
                          {notRenewing ? (row.status === "cancelled" ? "cancelled" : "lapsing") : "renewing"}
                        </Badge>
                      </td>
                      <td className="py-2 text-parchment/60">
                        {at ? <LocalDateTime iso={at} style="date" /> : "—"}
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
              No idle pooled boxes — nothing rents while serving nobody.
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
                    {box.monthlyCents !== null ? `${money(box.monthlyCents)}/mo` : "—"}
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
