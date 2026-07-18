import { listBusinesses } from "@/lib/db/businesses";
import { getTranslations } from "next-intl/server";
import {
  getFleetCalendarMonthUsageByBusiness,
  type BusinessMonthUsage
} from "@/lib/db/usage";
import { listTelnyxCostDaily } from "@/lib/db/platform-costs";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import { getTierLimits } from "@/lib/plans/limits";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import {
  computeUtilizationPct,
  listRecentMonths,
  monthWindow,
  resolveSelectedMonth,
  telnyxMicrosByBusinessInWindow
} from "@/lib/admin/usage-view";
import { logger } from "@/lib/logger";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export default async function AdminUsagePage({
  searchParams
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const t = await getTranslations("admin.pages");
  const now = new Date();
  const { month: monthParam } = await searchParams;
  const months = listRecentMonths(now, 3);
  const selected = resolveSelectedMonth(monthParam, months);
  const window = monthWindow(selected);
  const isCurrentMonth = selected === months[0];

  // Current month rides the margin loader (usage + AI spend + margins in
  // one pass); historical months read the rolled-up sources directly and
  // show no AI/margin columns (period-keyed spend can't be re-windowed).
  const margins = isCurrentMonth ? await loadFleetMargins(now) : null;
  const businesses = margins?.businesses ?? (await listBusinesses());
  const usageByBusiness: Map<string, BusinessMonthUsage> =
    margins?.usageByBusiness ??
    (await getFleetCalendarMonthUsageByBusiness(undefined, {
      startYmd: window.startYmd,
      endYmdExclusive: window.endYmdExclusive
    }).catch((err: unknown) => {
      logger.error("admin usage: usage rollup failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return new Map<string, BusinessMonthUsage>();
    }));

  const telnyxRows = await listTelnyxCostDaily(window.startYmd).catch((err: unknown) => {
    logger.error("admin usage: telnyx read failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return [];
  });
  const telnyx = telnyxMicrosByBusinessInWindow(telnyxRows, window);

  const rows = businesses
    .map((business) => {
      const usage = usageByBusiness.get(business.id);
      const voiceMinutes = usage?.voiceMinutes ?? 0;
      const smsSent = usage?.smsSent ?? 0;
      const aiSpendMicros = margins
        ? (margins.aiSpendMicrosByBusiness.get(business.id) ?? 0)
        : null;
      const aiCapMicros = chatSpendBaseCapMicrosForTier(business.tier);
      const limits = getTierLimits(business.tier, business.enterprise_limits);
      return {
        business,
        voiceMinutes,
        smsSent,
        callsMade: usage?.callsMade ?? 0,
        peakConcurrentCalls: usage?.peakConcurrentCalls ?? 0,
        aiSpendMicros,
        aiCapMicros,
        includedVoiceMinutes: limits.voiceIncludedSecondsPerStripePeriod / 60,
        smsCap: limits.smsPerMonth,
        utilizationPct: computeUtilizationPct({
          tier: business.tier,
          enterpriseLimitsOverride: business.enterprise_limits,
          voiceMinutes,
          smsSent,
          aiSpendMicros,
          aiCapMicros
        }),
        telnyxMicros: telnyx.hasRows ? (telnyx.byBusiness.get(business.id) ?? 0) : null,
        marginCents: margins?.byBusiness.get(business.id)?.marginCents ?? null
      };
    })
    .sort((a, b) => b.utilizationPct - a.utilizationPct);

  const fleetVoice = rows.reduce((sum, r) => sum + r.voiceMinutes, 0);
  const fleetSms = rows.reduce((sum, r) => sum + r.smsSent, 0);
  const fleetCalls = rows.reduce((sum, r) => sum + r.callsMade, 0);
  const fleetAiMicros = margins
    ? [...margins.aiSpendMicrosByBusiness.values()].reduce((sum, v) => sum + v, 0)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("usageTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("usageSubtitle")}</p>
        </div>
        <div className="flex items-center gap-1">
          {months.map((ym) => (
            <a
              key={ym}
              href={`/admin/usage?month=${ym}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                ym === selected
                  ? "bg-signal-teal/20 text-signal-teal"
                  : "text-parchment/50 hover:text-parchment border border-parchment/10"
              }`}
            >
              {ym}
            </a>
          ))}
        </div>
      </div>

      {/* Fleet totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Voice Minutes</p>
          <p className="text-3xl font-bold text-parchment">{fleetVoice.toFixed(0)}</p>
          <p className="text-xs text-parchment/30 mt-1">settled, fleet-wide · {selected}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">SMS Sent</p>
          <p className="text-3xl font-bold text-parchment">{fleetSms.toLocaleString("en-US")}</p>
          <p className="text-xs text-parchment/30 mt-1">metered outbound · {selected}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Calls</p>
          <p className="text-3xl font-bold text-parchment">{fleetCalls.toLocaleString("en-US")}</p>
          <p className="text-xs text-parchment/30 mt-1">fleet-wide · {selected}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Gemini Chat</p>
          <p className="text-3xl font-bold text-parchment">
            {fleetAiMicros !== null ? money(fleetAiMicros / 10_000) : "—"}
          </p>
          <p className="text-xs text-parchment/30 mt-1">
            {fleetAiMicros !== null ? "current periods, metered" : "current month only"}
          </p>
        </Card>
      </div>

      {/* Per-tenant table */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Per Tenant · {selected}
          {!isCurrentMonth && " (AI spend + margin shown for the current month only)"}
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-parchment/40 text-center py-4">No businesses.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-parchment/40 text-left">
                  <th className="pb-2 font-medium">Business</th>
                  <th className="pb-2 font-medium">Tier</th>
                  <th className="pb-2 font-medium text-right">Voice min</th>
                  <th className="pb-2 font-medium text-right">SMS</th>
                  <th className="pb-2 font-medium text-right">Calls</th>
                  <th className="pb-2 font-medium text-right">Peak conc.</th>
                  <th className="pb-2 font-medium text-right">AI spend</th>
                  <th className="pb-2 font-medium text-right">Util %</th>
                  <th className="pb-2 font-medium text-right">Telnyx cost</th>
                  <th className="pb-2 font-medium text-right">Margin/mo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-parchment/8">
                {rows.map((row) => (
                  <tr key={row.business.id}>
                    <td className="py-2">
                      <a
                        href={`/admin/${row.business.id}`}
                        className="text-parchment font-medium hover:text-signal-teal"
                      >
                        {row.business.name}
                      </a>
                    </td>
                    <td className="py-2">
                      <Badge variant="neutral" className="capitalize">
                        {row.business.tier}
                      </Badge>
                    </td>
                    <td className="py-2 text-right text-parchment/70">
                      {row.voiceMinutes.toFixed(1)}
                      <span className="text-parchment/30">
                        {" "}
                        / {Number.isFinite(row.includedVoiceMinutes) ? row.includedVoiceMinutes.toFixed(0) : "∞"}
                      </span>
                    </td>
                    <td className="py-2 text-right text-parchment/70">
                      {row.smsSent.toLocaleString("en-US")}
                      <span className="text-parchment/30">
                        {" "}
                        / {Number.isFinite(row.smsCap) ? row.smsCap.toLocaleString("en-US") : "∞"}
                      </span>
                    </td>
                    <td className="py-2 text-right text-parchment/70">{row.callsMade}</td>
                    <td className="py-2 text-right text-parchment/70">{row.peakConcurrentCalls}</td>
                    <td className="py-2 text-right text-parchment/70">
                      {row.aiSpendMicros !== null ? (
                        <>
                          {money(row.aiSpendMicros / 10_000)}
                          <span className="text-parchment/30"> / {money(row.aiCapMicros / 10_000)}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <span
                        className={
                          row.utilizationPct >= 80
                            ? "text-spark-orange font-semibold"
                            : "text-parchment/70"
                        }
                      >
                        {row.utilizationPct}%
                      </span>
                    </td>
                    <td className="py-2 text-right text-parchment/70">
                      {row.telnyxMicros !== null ? money(row.telnyxMicros / 10_000) : "—"}
                    </td>
                    <td className="py-2 text-right">
                      {row.marginCents !== null ? (
                        <span
                          className={`font-semibold ${
                            row.marginCents >= 0 ? "text-claw-green" : "text-spark-orange"
                          }`}
                        >
                          {money(row.marginCents)}
                        </span>
                      ) : (
                        <span className="text-parchment/30">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-parchment/30 mt-3">
          Util % blends voice/SMS/AI against the tier&apos;s caps (the tier-economics canvas
          methodology). Telnyx cost is the synced invoice actual for the month; &quot;—&quot; means
          the sync has no rows for that window.
        </p>
      </Card>
    </div>
  );
}
