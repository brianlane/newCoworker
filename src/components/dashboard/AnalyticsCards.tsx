/**
 * Presentational pieces for /dashboard/analytics (Standard/Enterprise perk).
 *
 * Pure server-renderable markup — no state, no client JS beyond Next's Link.
 * Charts are CSS flex bars (the datasets are tiny: 30 day-points or 24
 * hour-buckets), which keeps the page dependency-free and instant. Day
 * drill-down is plain navigation (`?day=YYYY-MM-DD`), so the page stays a
 * server component. Data shaping lives in
 * `src/lib/analytics/dashboard-analytics.ts`.
 */

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  CallDirectionBadge,
  ForwardedBadge,
  SentimentBadge,
  StatusBadge,
  formatDuration
} from "@/components/dashboard/voice-transcript-helpers";
import type { AnalyticsDayDetail, DailyUsagePoint } from "@/lib/analytics/dashboard-analytics";
import type { VoiceCallSentiment } from "@/lib/db/voice-transcripts";

/** Weekday + day-of-month label for chart tooltips (UTC date string in, e.g. "Jun 12" out). */
function shortDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Full header label for the day drill-down, e.g. "Friday, Jun 12, 2026". */
function longDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function BarColumn({
  value,
  max,
  title,
  colorClass,
  href,
  selected
}: {
  value: number;
  max: number;
  title: string;
  colorClass: string;
  /** When set, the column is a link (day drill-down). */
  href?: string;
  selected?: boolean;
}) {
  // Zero-value days keep a 2px stub so the timeline reads continuously.
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
  const wrapperClass = [
    "flex-1 flex flex-col justify-end h-full min-w-0 rounded-sm",
    href ? "hover:bg-parchment/15 transition-colors" : "",
    selected ? "bg-parchment/15" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const bar = (
    <div
      className={["rounded-t", colorClass].join(" ")}
      style={{ height: pct > 0 ? `${pct}%` : "2px" }}
    />
  );
  if (href) {
    return (
      <Link href={href} className={wrapperClass} title={title} aria-label={title}>
        {bar}
      </Link>
    );
  }
  return (
    <div className={wrapperClass} title={title}>
      {bar}
    </div>
  );
}

export function DailyVolumeCard({
  label,
  unit,
  total,
  days,
  value,
  colorClass,
  dayHref,
  selectedDate
}: {
  label: string;
  /** e.g. "calls", "texts", "min" — appended to the total. */
  unit: string;
  total: number;
  days: DailyUsagePoint[];
  value: (p: DailyUsagePoint) => number;
  colorClass: string;
  /** When set, each day bar links to its drill-down URL. */
  dayHref?: (date: string) => string;
  /** Day currently drilled into (highlighted across all three charts). */
  selectedDate?: string | null;
}) {
  const max = Math.max(...days.map(value), 0);
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-parchment">
        {total.toLocaleString()} <span className="text-sm font-normal text-parchment/50">{unit}</span>
      </p>
      <div className="flex items-end gap-px h-16 mt-3">
        {days.map((p) => (
          <BarColumn
            key={p.date}
            value={value(p)}
            max={max}
            title={`${shortDate(p.date)}: ${value(p).toLocaleString()} ${unit}`}
            colorClass={colorClass}
            href={dayHref ? dayHref(p.date) : undefined}
            selected={selectedDate === p.date}
          />
        ))}
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-parchment/35">
        <span>{days.length > 0 ? shortDate(days[0].date) : ""}</span>
        <span>{days.length > 0 ? shortDate(days[days.length - 1].date) : ""}</span>
      </div>
    </Card>
  );
}

/**
 * One call row in the day drill-down, pre-labeled on the server (owner /
 * employee / contact-name overrides already resolved) — mirrors CallListRow.
 */
export type DayDetailCallDisplayRow = AnalyticsDayDetail["calls"][number] & {
  label: string;
  badgeKind: "owner" | "employee" | null;
};

/**
 * Drill-down card for one UTC day of the volume charts: that day's totals,
 * the individual calls (deep-linking into /dashboard/calls/[id]), and the
 * turned-away count. Rendered when the owner clicks a bar (`?day=…`).
 */
export function DayDetailCard({
  detail,
  calls,
  closeHref
}: {
  detail: AnalyticsDayDetail;
  calls: DayDetailCallDisplayRow[];
  closeHref: string;
}) {
  return (
    <Card>
      <div id="day-detail" className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Day detail</p>
          <p className="text-lg font-bold text-parchment">{longDate(detail.date)}</p>
        </div>
        <Link
          href={closeHref}
          className="text-xs text-parchment/50 hover:text-parchment transition-colors shrink-0 mt-1"
        >
          ✕ Back to 30 days
        </Link>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-parchment/70">
        <span>
          <span className="font-semibold text-parchment">{detail.usage.calls.toLocaleString()}</span>{" "}
          calls
        </span>
        <span>
          <span className="font-semibold text-parchment">{detail.usage.sms.toLocaleString()}</span>{" "}
          texts
        </span>
        <span>
          <span className="font-semibold text-parchment">
            {detail.usage.voiceMinutes.toLocaleString()}
          </span>{" "}
          voice min
        </span>
        {detail.turnedAway > 0 && (
          <span className="text-red-300">
            <span className="font-semibold">{detail.turnedAway.toLocaleString()}</span> turned away
          </span>
        )}
      </div>

      {calls.length === 0 ? (
        <p className="text-sm text-parchment/50 mt-4">No calls on this day.</p>
      ) : (
        <ul className="divide-y divide-parchment/10 mt-3">
          {calls.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/calls/${row.id}`}
                className="flex items-center justify-between gap-4 px-2 py-2.5 rounded-lg hover:bg-parchment/5 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CallDirectionBadge direction={row.direction} />
                    <span className="text-sm font-semibold text-parchment truncate">
                      {row.label}
                    </span>
                    {row.badgeKind && (
                      <span className="text-[10px] uppercase tracking-wide text-parchment/40">
                        {row.badgeKind}
                      </span>
                    )}
                    {row.callKind === "forwarded" && <ForwardedBadge />}
                    <StatusBadge status={row.status} />
                    {row.sentiment && <SentimentBadge sentiment={row.sentiment} />}
                  </div>
                  <p className="text-xs text-parchment/50 mt-0.5">
                    <LocalDateTime iso={row.startedAt} /> ·{" "}
                    {formatDuration(row.startedAt, row.endedAt)}
                    {row.callKind === "forwarded" && row.forwardedTo && (
                      <span className="font-mono"> · to {row.forwardedTo}</span>
                    )}
                  </p>
                  {row.summary && (
                    <p className="text-xs text-parchment/60 mt-1 line-clamp-2">{row.summary}</p>
                  )}
                </div>
                <span className="text-parchment/40 text-sm shrink-0">View →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[10px] text-parchment/35 mt-3">
        {detail.clipped
          ? `Showing the most recent ${calls.length.toLocaleString()} calls for this day. `
          : ""}
        Days follow the UTC calendar, matching the charts above.
      </p>
    </Card>
  );
}

export function AnswerRateCard({
  answered,
  missed,
  rate
}: {
  answered: number;
  missed: number;
  rate: number | null;
}) {
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Answer rate (30 days)
      </p>
      {rate === null ? (
        <p className="text-sm text-parchment/50 mt-2">No inbound calls yet.</p>
      ) : (
        <>
          <p
            className={[
              "text-2xl font-bold",
              rate >= 0.95 ? "text-claw-green" : rate >= 0.8 ? "text-amber-300" : "text-red-300"
            ].join(" ")}
          >
            {Math.round(rate * 100)}%
          </p>
          <p className="text-xs text-parchment/50 mt-1">
            {answered.toLocaleString()} answered · {missed.toLocaleString()} turned away
          </p>
          {missed > 0 && (
            <p className="text-xs text-parchment/40 mt-2 leading-relaxed">
              Turned-away callers hit your concurrent-call limit or ran into exhausted voice
              minutes. Upgrading concurrency or topping up minutes stops the misses.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function PeakHoursCard({
  hourBuckets,
  callCount,
  clipped,
  timeZoneLabel
}: {
  hourBuckets: number[];
  callCount: number;
  /** Scan hit its row cap — the histogram covers the most recent attempts only. */
  clipped: boolean;
  timeZoneLabel: string;
}) {
  const max = Math.max(...hourBuckets, 0);
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Peak call hours (30 days)
      </p>
      {callCount === 0 ? (
        <p className="text-sm text-parchment/50 mt-2">No inbound calls yet.</p>
      ) : (
        <>
          <div className="flex items-end gap-px h-16 mt-3">
            {hourBuckets.map((count, hour) => (
              <BarColumn
                key={hour}
                value={count}
                max={max}
                title={`${hour}:00 – ${count.toLocaleString()} call${count === 1 ? "" : "s"}`}
                colorClass="bg-signal-teal/70"
              />
            ))}
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-parchment/35">
            <span>12am</span>
            <span>6am</span>
            <span>12pm</span>
            <span>6pm</span>
            <span>11pm</span>
          </div>
          <p className="text-xs text-parchment/40 mt-2">
            {clipped ? "Most recent " : ""}
            {callCount.toLocaleString()} inbound call attempts (answered + turned away) ·{" "}
            {timeZoneLabel}
          </p>
        </>
      )}
    </Card>
  );
}

const SENTIMENT_STYLES: Record<VoiceCallSentiment, { bar: string; label: string }> = {
  positive: { bar: "bg-claw-green/70", label: "Positive" },
  neutral: { bar: "bg-parchment/30", label: "Neutral" },
  negative: { bar: "bg-red-400/70", label: "Negative" },
  mixed: { bar: "bg-amber-300/70", label: "Mixed" }
};

export function SentimentMixCard({
  sentiment,
  total
}: {
  sentiment: Record<VoiceCallSentiment, number>;
  total: number;
}) {
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Caller sentiment (30 days)
      </p>
      {total === 0 ? (
        <p className="text-sm text-parchment/50 mt-2">
          No summarized calls yet; sentiment appears as AI call summaries are generated.
        </p>
      ) : (
        <div className="space-y-2 mt-3">
          {(Object.keys(SENTIMENT_STYLES) as VoiceCallSentiment[]).map((key) => {
            const count = sentiment[key];
            const pct = Math.round((count / total) * 100);
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs text-parchment/60 w-16">{SENTIMENT_STYLES[key].label}</span>
                <div className="flex-1 h-2 rounded bg-parchment/5 overflow-hidden">
                  <div
                    className={["h-full rounded", SENTIMENT_STYLES[key].bar].join(" ")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-parchment/50 w-10 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
