import { getTranslations } from "next-intl/server";
import { listBusinesses } from "@/lib/db/businesses";
import { listGeminiBilledDaily, listGeminiSpendDaily } from "@/lib/db/gemini-spend";
import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import {
  GEMINI_BILLED_SYNC_STATUS_KEY,
  parseGeminiBilledSyncStatus
} from "@/lib/admin/gemini-billed-sync";
import {
  GEMINI_RANGE_KEYS,
  buildGeminiDailySeries,
  buildGeminiReconciliation,
  buildGeminiTenantBreakdown,
  geminiRangeWindow,
  resolveGeminiRange
} from "@/lib/admin/gemini-usage-view";
import { logger } from "@/lib/logger";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export const dynamic = "force-dynamic";

function microsToMoney(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

const RANGE_LABELS: Record<string, string> = {
  today: "Today",
  "7d": "7 days",
  month: "This month",
  "90d": "90 days"
};

// Stack palette for the per-tenant daily chart (assigned by spend rank).
const SEGMENT_CLASSES = [
  "bg-signal-teal/80",
  "bg-spark-orange/70",
  "bg-claw-green/70",
  "bg-parchment/50",
  "bg-signal-teal/40",
  "bg-spark-orange/40",
  "bg-claw-green/40",
  "bg-parchment/25"
];

export default async function AdminGeminiPage({
  searchParams
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const now = new Date();
  const { range: rangeParam } = await searchParams;
  const range = resolveGeminiRange(rangeParam);
  const window = geminiRangeWindow(range, now);
  // One fetch covers every selectable range (90d is the widest).
  const fetchSinceYmd = geminiRangeWindow("90d", now).startYmd;

  const [businesses, spendRows, billedRows, billedStatusRaw] = await Promise.all([
    listBusinesses().catch(() => []),
    listGeminiSpendDaily(fetchSinceYmd).catch((err: unknown) => {
      logger.error("admin gemini: spend ledger read failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return [];
    }),
    listGeminiBilledDaily(fetchSinceYmd).catch((err: unknown) => {
      logger.error("admin gemini: billed read failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return [];
    }),
    getAdminPlatformSetting(GEMINI_BILLED_SYNC_STATUS_KEY).catch(() => null)
  ]);

  const billedStatus = parseGeminiBilledSyncStatus(billedStatusRaw);
  const businessNames = new Map(businesses.map((b) => [b.id, b.name]));
  const nameOf = (businessId: string): string =>
    businessNames.get(businessId) ?? `${businessId.slice(0, 8)}…`;

  const series = buildGeminiDailySeries(spendRows, window);
  const tenants = buildGeminiTenantBreakdown(spendRows, window);
  const reconciliation = buildGeminiReconciliation(spendRows, billedRows, window);
  const estimateMicros = tenants.reduce((sum, tenant) => sum + tenant.estimateMicros, 0);
  const callCount = tenants.reduce((sum, tenant) => sum + tenant.callCount, 0);

  // Stable stack colors: rank tenants by window spend.
  const segmentClassByBusiness = new Map(
    tenants.map((tenant, i) => [
      tenant.businessId,
      SEGMENT_CLASSES[Math.min(i, SEGMENT_CLASSES.length - 1)]
    ])
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("geminiTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("geminiSubtitle")}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {billedStatus ? (
              <>
                Billed sync <LocalDateTime iso={billedStatus.lastSyncAt} style="detail" /> ·{" "}
                {billedStatus.configured ? (
                  billedStatus.ok ? (
                    `OK (${billedStatus.rows} rows)`
                  ) : (
                    <span className="text-spark-orange">{billedStatus.error}</span>
                  )
                ) : (
                  "not configured — metered ledger only (docs/GEMINI-SPEND.md)"
                )}
              </>
            ) : (
              "Billed sync has never run — Google actuals appear after the next daily sync (or Costs → Sync now)."
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {GEMINI_RANGE_KEYS.map((key) => (
            <a
              key={key}
              href={`/admin/gemini?range=${key}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                key === range
                  ? "bg-signal-teal/20 text-signal-teal"
                  : "text-parchment/50 hover:text-parchment border border-parchment/10"
              }`}
            >
              {RANGE_LABELS[key]}
            </a>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Metered Spend</p>
          <p className="text-3xl font-bold text-parchment">{microsToMoney(series.totalMicros)}</p>
          <p className="text-xs text-parchment/30 mt-1">
            ledger · {window.startYmd} → {window.endYmdExclusive} (UTC days)
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Google Billed</p>
          <p className="text-3xl font-bold text-parchment">
            {reconciliation.latestBilledDay !== null
              ? microsToMoney(reconciliation.billedTotalMicros)
              : "—"}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {reconciliation.latestBilledDay !== null
              ? `synced actuals through ${reconciliation.latestBilledDay}`
              : "no synced billing rows in range"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Billed − Metered
          </p>
          <p
            className={`text-3xl font-bold ${
              reconciliation.latestBilledDay !== null && reconciliation.deltaMicros > 0
                ? "text-spark-orange"
                : "text-parchment"
            }`}
          >
            {reconciliation.latestBilledDay !== null
              ? microsToMoney(reconciliation.deltaMicros)
              : "—"}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {reconciliation.latestBilledDay !== null
              ? `vs ${microsToMoney(reconciliation.meteredComparableMicros)} metered on billed days${
                  reconciliation.deltaPct !== null ? ` · ${reconciliation.deltaPct}%` : ""
                }`
              : "needs the billed sync"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Metered Calls</p>
          <p className="text-3xl font-bold text-parchment">{callCount.toLocaleString("en-US")}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {estimateMicros > 0
              ? `${microsToMoney(estimateMicros)} estimate-priced (chars/4)`
              : "all exact-token or per-unit priced"}
          </p>
        </Card>
      </div>

      {/* Daily chart */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Metered Spend by Day (stacked per tenant)
        </h2>
        {series.totalMicros === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No metered Gemini calls in this range. The ledger collects from the day this shipped —
            older spend exists only in the period fuse totals.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-1 h-36">
              {series.points.map((point) => (
                <div
                  key={point.day}
                  className="flex-1 flex flex-col justify-end h-full min-w-0"
                  title={`${point.day} · ${microsToMoney(point.costMicros)}${point.segments
                    .map((s) => `\n${nameOf(s.businessId)}: ${microsToMoney(s.costMicros)}`)
                    .join("")}`}
                >
                  {/* Visibility floor applies ONCE to the whole column (not per
                      segment — per-segment floors would compound and inflate
                      days with many small tenants); segments then split the
                      column exactly proportionally. */}
                  {point.costMicros > 0 && (
                    <div
                      className="w-full flex flex-col"
                      style={{
                        height: `${Math.max((point.costMicros / series.maxMicros) * 100, 1.5)}%`
                      }}
                    >
                      {point.segments.map((segment) => (
                        <div
                          key={segment.businessId}
                          className={`w-full ${segmentClassByBusiness.get(segment.businessId) ?? "bg-parchment/25"}`}
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
              <span>{series.points[0]?.day}</span>
              <span>{series.points[series.points.length - 1]?.day}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
              {tenants.slice(0, SEGMENT_CLASSES.length).map((tenant) => (
                <span key={tenant.businessId} className="flex items-center gap-1.5 text-xs">
                  <span
                    className={`inline-block h-2 w-2 rounded-sm ${segmentClassByBusiness.get(tenant.businessId)}`}
                  />
                  <span className="text-parchment/60">{nameOf(tenant.businessId)}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Reconciliation detail */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Metered vs Google Billed (reconciliation)
        </h2>
        {reconciliation.latestBilledDay === null ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No synced billing rows in this range yet. Billed actuals come from the Cloud Billing
            BigQuery export (setup: docs/GEMINI-SPEND.md) and lag Google by up to 24h.
          </p>
        ) : (
          <div className="space-y-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">GCP project</th>
                  <th className="pb-2 font-medium text-right">Billed in range</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {reconciliation.byProject.map((project) => (
                  <tr key={project.projectId}>
                    <td className="py-2 font-mono text-parchment/80">{project.projectId}</td>
                    <td className="py-2 text-right text-parchment font-medium">
                      {microsToMoney(project.costMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reconciliation.deltaMicros > 0 && (
              <p className="text-xs text-spark-orange/80">
                Google billed {microsToMoney(reconciliation.deltaMicros)} more than the ledger
                metered on the same days — internal-project (CI/debug) traffic is expected here;
                anything on the production project means an unmetered surface or price drift.
              </p>
            )}
            <p className="text-xs text-parchment/30">
              Comparison clipped to days with synced billing (through{" "}
              {reconciliation.latestBilledDay}); billed data lags up to 24h.
            </p>
          </div>
        )}
      </Card>

      {/* Per-tenant breakdown */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Per Tenant · Surface × Model
        </h2>
        {tenants.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">
            No metered Gemini calls in this range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Business / surface</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium text-right">Calls</th>
                  <th className="pb-2 font-medium text-right">Tokens in / out</th>
                  <th className="pb-2 font-medium text-right">Estimate share</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {tenants.flatMap((tenant) => [
                  <tr key={tenant.businessId} className="bg-parchment/[0.03]">
                    <td className="py-2" colSpan={2}>
                      <a
                        href={`/admin/${tenant.businessId}`}
                        className="text-parchment font-semibold hover:text-signal-teal"
                      >
                        {nameOf(tenant.businessId)}
                      </a>
                    </td>
                    <td className="py-2 text-right text-parchment/70">
                      {tenant.callCount.toLocaleString("en-US")}
                    </td>
                    <td className="py-2" />
                    <td className="py-2 text-right text-parchment/50">
                      {tenant.costMicros > 0
                        ? `${Math.round((tenant.estimateMicros / tenant.costMicros) * 100)}%`
                        : "0%"}
                    </td>
                    <td className="py-2 text-right text-parchment font-semibold">
                      {microsToMoney(tenant.costMicros)}
                    </td>
                  </tr>,
                  ...tenant.lines.map((line) => (
                    <tr key={`${tenant.businessId}|${line.surface}|${line.model}`}>
                      <td className="py-1.5 pl-4 text-parchment/60">{line.surface}</td>
                      <td className="py-1.5 font-mono text-parchment/50">{line.model}</td>
                      <td className="py-1.5 text-right text-parchment/60">
                        {line.callCount.toLocaleString("en-US")}
                      </td>
                      <td className="py-1.5 text-right text-parchment/50">
                        {line.promptTokens.toLocaleString("en-US")} /{" "}
                        {line.outputTokens.toLocaleString("en-US")}
                      </td>
                      <td className="py-1.5 text-right text-parchment/40">
                        {line.costMicros > 0
                          ? `${Math.round((line.estimateMicros / line.costMicros) * 100)}%`
                          : "0%"}
                      </td>
                      <td className="py-1.5 text-right text-parchment/70">
                        {microsToMoney(line.costMicros)}
                      </td>
                    </tr>
                  ))
                ])}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-parchment/30 mt-3">
          Every metered Gemini call lands here (chat, SMS, webchat, Messenger/WhatsApp, AiFlows,
          voice Live, summarizers, ingest). &quot;Estimate share&quot; is spend priced by the
          chars/4 fallback instead of exact billed tokens. The period cap fuse is unchanged and
          lives on the Costs page.
        </p>
      </Card>
    </div>
  );
}
