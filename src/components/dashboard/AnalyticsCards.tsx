/**
 * Presentational pieces for /dashboard/analytics (Standard/Enterprise perk).
 *
 * Pure server-renderable markup — no state, no client JS. Charts are CSS
 * flex bars (the datasets are tiny: 30 day-points or 24 hour-buckets), which
 * keeps the page dependency-free and instant. Data shaping lives in
 * `src/lib/analytics/dashboard-analytics.ts`.
 */

import { Card } from "@/components/ui/Card";
import type { DailyUsagePoint } from "@/lib/analytics/dashboard-analytics";
import type { VoiceCallSentiment } from "@/lib/db/voice-transcripts";

/** Weekday + day-of-month label for chart tooltips (UTC date string in, e.g. "Jun 12" out). */
function shortDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function BarColumn({
  value,
  max,
  title,
  colorClass
}: {
  value: number;
  max: number;
  title: string;
  colorClass: string;
}) {
  // Zero-value days keep a 2px stub so the timeline reads continuously.
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
  return (
    <div className="flex-1 flex flex-col justify-end h-full min-w-0" title={title}>
      <div
        className={["rounded-t", colorClass].join(" ")}
        style={{ height: pct > 0 ? `${pct}%` : "2px" }}
      />
    </div>
  );
}

export function DailyVolumeCard({
  label,
  unit,
  total,
  days,
  value,
  colorClass
}: {
  label: string;
  /** e.g. "calls", "texts", "min" — appended to the total. */
  unit: string;
  total: number;
  days: DailyUsagePoint[];
  value: (p: DailyUsagePoint) => number;
  colorClass: string;
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
  timeZoneLabel
}: {
  hourBuckets: number[];
  callCount: number;
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
          No summarized calls yet — sentiment appears as AI call summaries are generated.
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
