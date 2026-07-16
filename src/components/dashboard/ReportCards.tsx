/**
 * Presentational report cards for /dashboard/analytics — the operational
 * reporting suite (renewal pipeline, response times, retention, monthly
 * summary). Pure server-renderable markup, matching AnalyticsCards.tsx:
 * no client JS, tiny datasets, CSS-only visuals. Data shaping lives in
 * src/lib/analytics/{renewal-pipeline,response-times,retention,monthly-summary}.ts.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { RenewalBucket, RenewalPipeline } from "@/lib/analytics/renewal-pipeline";
import type { ResponseTimeStats } from "@/lib/analytics/response-times";
import type { RetentionOverview } from "@/lib/analytics/retention";
import type { MonthlySummary } from "@/lib/analytics/monthly-summary";
import {
  QUOTE_LOST_TAG,
  QUOTE_STAGE_LABELS,
  QUOTE_STAGE_TAGS,
  type QuoteFunnel
} from "@/lib/analytics/quote-funnel";

const BUCKET_LABELS: Record<RenewalBucket, string> = {
  overdue: "Overdue",
  next30: "Next 30 days",
  next60: "31–60 days",
  next90: "61–90 days"
};

const BUCKET_TONES: Record<RenewalBucket, string> = {
  overdue: "text-spark-orange",
  next30: "text-amber-300",
  next60: "text-parchment/80",
  next90: "text-parchment/60"
};

/** "2m 5s" / "48s" for response-time stats. */
function seconds(value: number): string {
  if (value < 60) return `${value}s`;
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function RenewalPipelineCard({ pipeline }: { pipeline: RenewalPipeline }) {
  const shown = pipeline.rows.slice(0, 12);
  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">Renewal pipeline</h2>
      <p className="text-xs text-parchment/50 mt-0.5 mb-3">
        Overdue first, then everything renewing in the next 90 days
        {pipeline.clipped ? " (list capped at the most urgent)" : ""}
      </p>
      <div className="grid grid-cols-4 gap-2 mb-4">
        {(Object.keys(BUCKET_LABELS) as RenewalBucket[]).map((bucket) => (
          <div key={bucket} className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
            <p className={`text-lg font-bold ${BUCKET_TONES[bucket]}`}>
              {pipeline.counts[bucket]}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-parchment/40">
              {BUCKET_LABELS[bucket]}
            </p>
          </div>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-parchment/40">
          Nothing coming up. Add renewal dates to documents (or import a book of business from
          Import / Export) and they&apos;ll appear here.
        </p>
      ) : (
        <ul className="divide-y divide-parchment/10">
          {shown.map((row) => (
            <li key={row.documentId} className="py-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-parchment/90">{row.title}</span>
              {row.contactName || row.contactE164 ? (
                <Link
                  href={
                    row.contactE164
                      ? `/dashboard/customers/${encodeURIComponent(row.contactE164)}`
                      : "/dashboard/customers"
                  }
                  className="text-signal-teal hover:underline"
                >
                  {row.contactName ?? row.contactE164}
                </Link>
              ) : null}
              <span className={`ml-auto ${BUCKET_TONES[row.bucket]}`}>
                {row.daysUntil < 0
                  ? `${-row.daysUntil}d overdue`
                  : row.daysUntil === 0
                    ? "today"
                    : `in ${row.daysUntil}d`}
              </span>
              <span className="text-parchment/40">{row.renewalDate}</span>
              {row.assignedEmployee && (
                <span className="text-parchment/40">→ {row.assignedEmployee}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {pipeline.byAssignee.length > 0 && shown.length > 0 && (
        <p className="text-[11px] text-parchment/40 mt-3">
          By handler:{" "}
          {pipeline.byAssignee.map((a, i) => (
            <span key={a.name}>
              {i > 0 ? " · " : ""}
              {a.name} ({a.count})
            </span>
          ))}
        </p>
      )}
    </Card>
  );
}

export function ResponseTimeCard({ stats }: { stats: ResponseTimeStats }) {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">Response times</h2>
      <p className="text-xs text-parchment/50 mt-0.5 mb-3">
        How fast inbound texts got answered (30 days)
        {stats.clipped ? " — most recent texts only" : ""}
      </p>
      {stats.repliedCount === 0 ? (
        <>
          <p className="text-xs text-parchment/40">No replied texts in the window yet.</p>
          {/* Dead-letters matter MOST when nothing got a reply — never hide
              them behind the replied-count branch. */}
          {stats.deadLetterCount > 0 && (
            <p className="text-[11px] text-spark-orange mt-2">
              {stats.deadLetterCount} inbound text{stats.deadLetterCount === 1 ? "" : "s"} needed
              human follow-up.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-parchment">{seconds(stats.medianSeconds ?? 0)}</p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">Median</p>
            </div>
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-parchment">{seconds(stats.p90Seconds ?? 0)}</p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">90th pct</p>
            </div>
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-claw-green">
                {Math.round((stats.underMinuteShare ?? 0) * 100)}%
              </p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">Under 1 min</p>
            </div>
          </div>
          <p className="text-[11px] text-parchment/40 mt-3">
            {stats.repliedCount.toLocaleString()} replied text
            {stats.repliedCount === 1 ? "" : "s"}
            {stats.deadLetterCount > 0
              ? ` · ${stats.deadLetterCount} needed human follow-up`
              : ""}
          </p>
        </>
      )}
    </Card>
  );
}

export function RetentionCard({ retention }: { retention: RetentionOverview }) {
  const rate = retention.retentionRate;
  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">Customer retention</h2>
      <p className="text-xs text-parchment/50 mt-0.5 mb-3">
        Of everyone you&apos;ve talked to, who&apos;s still engaged
        {retention.clipped ? " (directory capped)" : ""}
      </p>
      {retention.engagedEver === 0 ? (
        <p className="text-xs text-parchment/40">No customer conversations yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-claw-green">
                {rate !== null ? `${Math.round(rate * 100)}%` : "—"}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">Retained</p>
            </div>
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-amber-300">{retention.atRisk}</p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">At risk</p>
            </div>
            <div className="rounded-lg border border-parchment/10 px-2 py-2 text-center">
              <p className="text-lg font-bold text-spark-orange">{retention.lapsed}</p>
              <p className="text-[10px] uppercase tracking-wide text-parchment/40">Lapsed</p>
            </div>
          </div>
          <p className="text-[11px] text-parchment/40 mt-3">
            {retention.retained} of {retention.engagedEver} engaged customers active in the last 30
            days · {retention.returning} returning · {retention.newInWindow} new contact
            {retention.newInWindow === 1 ? "" : "s"} added
          </p>
        </>
      )}
    </Card>
  );
}

function MonthColumn({
  label,
  month,
  emphasize
}: {
  label: string;
  month: MonthlySummary["current"];
  emphasize?: boolean;
}) {
  const rows: Array<[string, number]> = [
    ["Calls", month.calls],
    ["Texts", month.texts],
    ["Voice minutes", month.voiceMinutes],
    ["Missed calls", month.missedCalls],
    ["New contacts", month.newContacts]
  ];
  return (
    <div className={`rounded-lg border px-3 py-2 ${emphasize ? "border-signal-teal/40" : "border-parchment/10"}`}>
      <p className="text-[10px] uppercase tracking-wide text-parchment/40 mb-1">
        {label} <span className="text-parchment/30">({month.month})</span>
      </p>
      <ul className="space-y-0.5">
        {rows.map(([name, value]) => (
          <li key={name} className="flex justify-between text-xs">
            <span className="text-parchment/60">{name}</span>
            <span className="text-parchment/90 font-semibold">{value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function QuoteFunnelCard({ funnel }: { funnel: QuoteFunnel }) {
  const ladderMax = Math.max(...QUOTE_STAGE_TAGS.map((t) => funnel.counts[t]), 1);
  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">Quote funnel</h2>
      <p className="text-xs text-parchment/50 mt-0.5 mb-3">
        Contacts by quote stage — each counted at their furthest stage
        {funnel.clipped ? " (directory capped)" : ""}
      </p>
      <div className="space-y-1.5">
        {QUOTE_STAGE_TAGS.map((tag) => (
          <div key={tag} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-parchment/60">
              {QUOTE_STAGE_LABELS[tag]}
            </span>
            <div className="flex-1 h-3 rounded bg-parchment/5">
              <div
                className={`h-3 rounded ${tag === "quote-won" ? "bg-claw-green/70" : "bg-signal-teal/60"}`}
                style={{ width: `${Math.max((funnel.counts[tag] / ladderMax) * 100, funnel.counts[tag] > 0 ? 4 : 0)}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs text-parchment/80">
              {funnel.counts[tag]}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-parchment/40 mt-3">
        {funnel.conversionRate !== null && (
          <span className="text-claw-green">
            {Math.round(funnel.conversionRate * 100)}% won
          </span>
        )}
        {funnel.counts[QUOTE_LOST_TAG] > 0 && (
          <span> · {funnel.counts[QUOTE_LOST_TAG]} lost</span>
        )}
        <span>
          {" "}
          · Track quotes by tagging contacts {QUOTE_STAGE_TAGS.join(" → ")} (AiFlows can set
          these automatically).
        </span>
      </p>
    </Card>
  );
}

export function MonthlySummaryCard({ summary }: { summary: MonthlySummary }) {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment">Monthly summary</h2>
      <p className="text-xs text-parchment/50 mt-0.5 mb-3">
        This month so far vs last month (nightly rollup — today lands tomorrow)
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <MonthColumn label="This month" month={summary.current} emphasize />
        <MonthColumn label="Last month" month={summary.previous} />
      </div>
    </Card>
  );
}
