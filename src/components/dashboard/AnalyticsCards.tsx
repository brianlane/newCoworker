/**
 * Presentational pieces for /dashboard/analytics (Standard/Enterprise perk).
 *
 * Pure server-renderable markup — no state, no client JS beyond Next's Link.
 * Charts are CSS flex bars (the datasets are tiny: 30 day-points or 24
 * hour-buckets), which keeps the page dependency-free and instant. Every
 * drill-down (day / sentiment / hour) is plain navigation (`?day=`,
 * `?sentiment=`, `?hour=`), so the page stays a server component. Data
 * shaping lives in `src/lib/analytics/dashboard-analytics.ts`.
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
import type {
  AnalyticsDayDetail,
  DailyUsagePoint,
  DayDetailText,
  PeriodChange
} from "@/lib/analytics/dashboard-analytics";
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

/**
 * "▲ 12% vs prior 30 days" delta line (BizBlasts period_comparison port).
 * A zero baseline shows the raw previous→current movement instead of a
 * meaningless percentage; flat metrics render muted.
 */
export function PeriodDeltaLine({ change }: { change: PeriodChange }) {
  const arrow = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "—";
  const tone =
    change.direction === "up"
      ? "text-claw-green"
      : change.direction === "down"
        ? "text-amber-300"
        : "text-parchment/40";
  const body =
    change.percent !== null
      ? `${Math.abs(change.percent)}%`
      : change.direction === "flat"
        ? "no change"
        : `${change.current.toLocaleString()} from ${change.previous.toLocaleString()}`;
  return (
    <p className={`text-[11px] mt-1 ${tone}`}>
      {arrow} {body} <span className="text-parchment/35">vs prior 30 days</span>
    </p>
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
  selectedDate,
  change
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
  /** Optional delta vs the prior window (period comparison). */
  change?: PeriodChange | null;
}) {
  const max = Math.max(...days.map(value), 0);
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-parchment">
        {total.toLocaleString()} <span className="text-sm font-normal text-parchment/50">{unit}</span>
      </p>
      {change ? <PeriodDeltaLine change={change} /> : null}
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
 * One call row in a drill-down list, pre-labeled on the server (owner /
 * employee / contact-name overrides already resolved) — mirrors CallListRow.
 */
export type DayDetailCallDisplayRow = AnalyticsDayDetail["calls"][number] & {
  label: string;
  badgeKind: "owner" | "employee" | null;
};

/** One text row in the day drill-down, pre-labeled on the server. */
export type DayDetailTextDisplayRow = DayDetailText & {
  label: string;
};

/** Shared call list for every drill-down card (day / sentiment / hour). */
function CallRowsList({ calls }: { calls: DayDetailCallDisplayRow[] }) {
  return (
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
                <span className="text-sm font-semibold text-parchment truncate">{row.label}</span>
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
  );
}

/** Received / Sent pill for text rows, mirroring the call direction badge. */
function TextDirectionBadge({ direction }: { direction: "inbound" | "outbound" }) {
  const outbound = direction === "outbound";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
        outbound ? "bg-claw-green/15 text-claw-green" : "bg-signal-teal/15 text-signal-teal"
      ].join(" ")}
    >
      {outbound ? "Sent" : "Received"}
    </span>
  );
}

/** Text list for the day drill-down; rows link into the SMS thread. */
function TextRowsList({ texts }: { texts: DayDetailTextDisplayRow[] }) {
  return (
    <ul className="divide-y divide-parchment/10 mt-3">
      {texts.map((row) => {
        const inner = (
          <>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <TextDirectionBadge direction={row.direction} />
                <span className="text-sm font-semibold text-parchment truncate">{row.label}</span>
                {row.channel === "rcs" && (
                  <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-parchment/10 text-parchment/60">
                    RCS
                  </span>
                )}
              </div>
              <p className="text-xs text-parchment/50 mt-0.5">
                <LocalDateTime iso={row.timestamp} />
              </p>
              <p className="text-xs text-parchment/60 mt-1 line-clamp-2">{row.content}</p>
            </div>
            {row.otherE164 && <span className="text-parchment/40 text-sm shrink-0">View →</span>}
          </>
        );
        return (
          <li key={row.id}>
            {row.otherE164 ? (
              <Link
                href={`/dashboard/messages/${encodeURIComponent(row.otherE164)}`}
                className="flex items-center justify-between gap-4 px-2 py-2.5 rounded-lg hover:bg-parchment/5 transition-colors"
              >
                {inner}
              </Link>
            ) : (
              <div className="flex items-center justify-between gap-4 px-2 py-2.5">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Drill-down card for one UTC day of the volume charts: that day's totals,
 * the individual calls (deep-linking into /dashboard/calls/[id]), the
 * individual texts (deep-linking into /dashboard/messages/[e164]), and the
 * turned-away count. Rendered when the owner clicks a bar (`?day=…`).
 */
export function DayDetailCard({
  detail,
  calls,
  texts,
  closeHref
}: {
  detail: AnalyticsDayDetail;
  calls: DayDetailCallDisplayRow[];
  texts: DayDetailTextDisplayRow[];
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
          texts sent
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

      <p className="text-xs text-parchment/40 uppercase tracking-wider mt-5">
        Calls ({calls.length.toLocaleString()})
      </p>
      {calls.length === 0 ? (
        <p className="text-sm text-parchment/50 mt-2">No calls on this day.</p>
      ) : (
        <CallRowsList calls={calls} />
      )}

      <p className="text-xs text-parchment/40 uppercase tracking-wider mt-5">
        Texts ({texts.length.toLocaleString()})
      </p>
      {texts.length === 0 ? (
        <p className="text-sm text-parchment/50 mt-2">No texts on this day.</p>
      ) : (
        <TextRowsList texts={texts} />
      )}

      <p className="text-[10px] text-parchment/35 mt-3">
        {detail.clipped
          ? `Showing the most recent ${calls.length.toLocaleString()} calls for this day. `
          : ""}
        {detail.textsClipped
          ? `Showing the most recent ${texts.length.toLocaleString()} texts for this day. `
          : ""}
        Days follow the UTC calendar, matching the charts above.
      </p>
    </Card>
  );
}

/**
 * Drill-down card for a sentiment row or a peak-hours bar: the window's
 * matching calls with their AI summaries — "what made all the calls
 * Neutral" is answered by reading them. Rendered on `?sentiment=` / `?hour=`.
 */
export function SegmentDetailCard({
  title,
  subtitle,
  calls,
  turnedAway,
  clipped,
  closeHref
}: {
  title: string;
  subtitle: string;
  calls: DayDetailCallDisplayRow[];
  /** Only set for the hour drill-down (refused attempts have no transcript). */
  turnedAway?: number;
  clipped: boolean;
  closeHref: string;
}) {
  return (
    <Card>
      <div id="segment-detail" className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">{subtitle}</p>
          <p className="text-lg font-bold text-parchment">{title}</p>
        </div>
        <Link
          href={closeHref}
          className="text-xs text-parchment/50 hover:text-parchment transition-colors shrink-0 mt-1"
        >
          ✕ Back to 30 days
        </Link>
      </div>

      {typeof turnedAway === "number" && turnedAway > 0 && (
        <p className="text-xs text-red-300 mt-2">
          {turnedAway.toLocaleString()} caller{turnedAway === 1 ? "" : "s"} turned away in this
          hour (no transcript to show).
        </p>
      )}

      {calls.length === 0 ? (
        <p className="text-sm text-parchment/50 mt-4">No matching calls in the last 30 days.</p>
      ) : (
        <CallRowsList calls={calls} />
      )}

      {clipped && (
        <p className="text-[10px] text-parchment/35 mt-3">
          Showing the most recent {calls.length.toLocaleString()} matching calls.
        </p>
      )}
    </Card>
  );
}

export type EngagementView = {
  counts: { new: number; active: number; cooling: number; quiet: number };
  total: number;
  quietCustomers: Array<{
    e164: string;
    name: string | null;
    lastInteractionAt: string | null;
    totalInteractions: number;
  }>;
  clipped: boolean;
};

const SEGMENT_META: Array<{
  key: keyof EngagementView["counts"];
  label: string;
  dotClass: string;
}> = [
  { key: "active", label: "Active (30d)", dotClass: "bg-claw-green" },
  { key: "cooling", label: "Cooling (30–90d)", dotClass: "bg-amber-300" },
  { key: "quiet", label: "Quiet (90d+)", dotClass: "bg-red-300" },
  { key: "new", label: "New", dotClass: "bg-signal-teal" }
];

/**
 * Customer engagement segments + the quiet ("win-back") shortlist —
 * BizBlasts RFM/churn port in engagement terms. Quiet customers order by
 * lifetime interactions so the most valuable lapsed relationships lead.
 */
export function EngagementCard({ view }: { view: EngagementView }) {
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Customer engagement
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2">
        {SEGMENT_META.map((seg) => (
          <span key={seg.key} className="text-sm text-parchment/70">
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${seg.dotClass}`} />
            {view.counts[seg.key].toLocaleString()}{" "}
            <span className="text-parchment/45">{seg.label}</span>
          </span>
        ))}
      </div>
      {view.clipped ? (
        <p className="text-[11px] text-amber-300/80 mt-2">
          Large directory — segment counts cover the first{" "}
          {view.total.toLocaleString()} customers scanned.
        </p>
      ) : null}
      {view.quietCustomers.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs text-parchment/50 mb-2">
            Gone quiet — your best win-back candidates:
          </p>
          <ul className="space-y-1.5">
            {view.quietCustomers.map((c) => (
              <li key={c.e164} className="text-sm flex items-baseline justify-between gap-3">
                <Link
                  href={`/dashboard/customers/${encodeURIComponent(c.e164)}`}
                  className="text-parchment/85 hover:text-parchment hover:underline truncate"
                >
                  {c.name ?? c.e164}
                </Link>
                <span className="text-xs text-parchment/40 whitespace-nowrap">
                  {c.totalInteractions.toLocaleString()} interactions
                  {c.lastInteractionAt ? (
                    <>
                      {" · last "}
                      <LocalDateTime iso={c.lastInteractionAt} style="date" />
                    </>
                  ) : (
                    " · never talked"
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-parchment/40 mt-3">
          Nobody has gone quiet — every customer has been in touch recently.
        </p>
      )}
    </Card>
  );
}

export type EmployeePerformanceView = {
  memberId: string;
  name: string;
  active: boolean;
  offered: number;
  claimed: number;
  claimRate: number | null;
  medianClaimMs: number | null;
  forwardedCalls: number;
};

/** "42 min" / "3.5 h" / "2 d" for the turnaround column. */
function humanizeMs(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * Owner-only roster leaderboard (BizBlasts StaffPerformanceService port):
 * lead offers/claims from AiFlow routing + calls the voice line forwarded.
 * Turnaround is approximate by design (see employee-performance.ts).
 */
export function EmployeePerformanceCard({ rows }: { rows: EmployeePerformanceView[] }) {
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Team performance (30 days) — owner view
      </p>
      <div className="mt-3 space-y-2">
        <div className="grid grid-cols-5 gap-2 text-[10px] uppercase tracking-wider text-parchment/35">
          <span>Teammate</span>
          <span className="text-right">Leads offered</span>
          <span className="text-right">Claimed</span>
          <span className="text-right">Typical turnaround</span>
          <span className="text-right">Calls forwarded</span>
        </div>
        {rows.map((row) => (
          <div key={row.memberId} className="grid grid-cols-5 gap-2 text-sm items-baseline">
            <span className="text-parchment/85 truncate">
              {row.name}
              {row.active ? "" : <span className="text-parchment/35"> (inactive)</span>}
            </span>
            <span className="text-right text-parchment/70">{row.offered.toLocaleString()}</span>
            <span className="text-right text-parchment/70">
              {row.claimed.toLocaleString()}
              {row.claimRate !== null ? (
                <span className="text-parchment/40"> ({Math.round(row.claimRate * 100)}%)</span>
              ) : null}
            </span>
            <span className="text-right text-parchment/70">
              {row.medianClaimMs !== null ? humanizeMs(row.medianClaimMs) : "—"}
            </span>
            <span className="text-right text-parchment/70">
              {row.forwardedCalls.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-parchment/35 mt-3">
        Turnaround approximates run start → claim settle and can include follow-up steps.
      </p>
    </Card>
  );
}

export type TrendWeek = { label: string; calls: number; sms: number };

export type TrendForecastView = {
  projected30d: number;
  direction: "up" | "down" | "stable";
  anomaly: "quiet" | "busy" | null;
};

/**
 * Long-window trend + 30-day activity forecast, fed by the nightly
 * analytics_daily_snapshots (BizBlasts AnalyticsSnapshot / forecast port).
 * Renders weekly aggregate bars — snapshots survive retention pruning, so
 * this window can extend past the raw-transcript history.
 */
export function TrendForecastCard({
  weeks,
  calls,
  texts
}: {
  weeks: TrendWeek[];
  calls: TrendForecastView | null;
  texts: TrendForecastView | null;
}) {
  const max = Math.max(...weeks.map((w) => w.calls + w.sms), 1);
  const directionWord = (d: TrendForecastView["direction"]) =>
    d === "up" ? "trending up" : d === "down" ? "trending down" : "steady";
  const anomaly = calls?.anomaly ?? texts?.anomaly ?? null;
  return (
    <Card>
      <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
        Trend &amp; forecast
      </p>
      <div className="flex items-end gap-1 h-16 mt-3">
        {weeks.map((w) => (
          <div
            key={w.label}
            className="flex-1 flex flex-col justify-end h-full min-w-0"
            title={`Week of ${w.label}: ${w.calls.toLocaleString()} calls · ${w.sms.toLocaleString()} texts`}
          >
            <div
              className="rounded-t bg-claw-green/60"
              style={{ height: `${Math.max((w.sms / max) * 100, w.sms > 0 ? 3 : 0)}%` }}
            />
            <div
              className="bg-signal-teal/70"
              style={{ height: `${Math.max((w.calls / max) * 100, w.calls > 0 ? 3 : 0)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-parchment/35">
        <span>{weeks[0]?.label ?? ""}</span>
        <span>{weeks[weeks.length - 1]?.label ?? ""}</span>
      </div>
      <p className="text-xs text-parchment/60 mt-3 leading-relaxed">
        Next 30 days on the current trend:{" "}
        {calls ? (
          <>
            ≈<span className="text-parchment/90">{calls.projected30d.toLocaleString()}</span>{" "}
            calls ({directionWord(calls.direction)})
          </>
        ) : (
          "not enough call history yet"
        )}
        {" · "}
        {texts ? (
          <>
            ≈<span className="text-parchment/90">{texts.projected30d.toLocaleString()}</span>{" "}
            texts ({directionWord(texts.direction)})
          </>
        ) : (
          "not enough text history yet"
        )}
      </p>
      {anomaly ? (
        <p className="text-xs text-amber-300/90 mt-2">
          {anomaly === "quiet"
            ? "Heads up: this week is running well below your usual volume."
            : "Heads up: this week is running well above your usual volume."}
        </p>
      ) : null}
      <p className="text-[10px] text-parchment/35 mt-2">
        <span className="text-signal-teal/80">■</span> calls{" "}
        <span className="text-claw-green/80 ml-2">■</span> texts · weekly totals from nightly
        snapshots
      </p>
    </Card>
  );
}

export function AnswerRateCard({
  answered,
  missed,
  rate,
  previousRate
}: {
  answered: number;
  missed: number;
  rate: number | null;
  /** Prior-window rate for the percentage-point delta line; null hides it. */
  previousRate?: number | null;
}) {
  const deltaPts =
    rate !== null && previousRate !== null && previousRate !== undefined
      ? Math.round((rate - previousRate) * 1000) / 10
      : null;
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
          {deltaPts !== null ? (
            <p
              className={`text-[11px] mt-1 ${
                deltaPts > 0
                  ? "text-claw-green"
                  : deltaPts < 0
                    ? "text-amber-300"
                    : "text-parchment/40"
              }`}
            >
              {deltaPts > 0 ? "▲" : deltaPts < 0 ? "▼" : "—"} {Math.abs(deltaPts)} pts{" "}
              <span className="text-parchment/35">vs prior 30 days</span>
            </p>
          ) : null}
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
  timeZoneLabel,
  hourHref,
  selectedHour
}: {
  hourBuckets: number[];
  callCount: number;
  /** Scan hit its row cap — the histogram covers the most recent attempts only. */
  clipped: boolean;
  timeZoneLabel: string;
  /** When set, each hour bar links to its drill-down URL. */
  hourHref?: (hour: number) => string;
  /** Hour currently drilled into (highlighted). */
  selectedHour?: number | null;
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
                href={hourHref ? hourHref(hour) : undefined}
                selected={selectedHour === hour}
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
            {hourHref ? " · click an hour to see its calls" : ""}
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
  total,
  sentimentHref,
  selectedSentiment
}: {
  sentiment: Record<VoiceCallSentiment, number>;
  total: number;
  /** When set, each sentiment row links to its drill-down URL. */
  sentimentHref?: (key: VoiceCallSentiment) => string;
  /** Sentiment currently drilled into (highlighted). */
  selectedSentiment?: VoiceCallSentiment | null;
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
        <>
          <div className="space-y-1 mt-3">
            {(Object.keys(SENTIMENT_STYLES) as VoiceCallSentiment[]).map((key) => {
              const count = sentiment[key];
              const pct = Math.round((count / total) * 100);
              const row = (
                <>
                  <span className="text-xs text-parchment/60 w-16">
                    {SENTIMENT_STYLES[key].label}
                  </span>
                  <div className="flex-1 h-2 rounded bg-parchment/5 overflow-hidden">
                    <div
                      className={["h-full rounded", SENTIMENT_STYLES[key].bar].join(" ")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs text-parchment/50 w-10 text-right">{pct}%</span>
                </>
              );
              const rowClass = [
                "flex items-center gap-2 rounded px-1 py-1",
                sentimentHref ? "hover:bg-parchment/10 transition-colors" : "",
                selectedSentiment === key ? "bg-parchment/10" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return sentimentHref ? (
                <Link
                  key={key}
                  href={sentimentHref(key)}
                  className={rowClass}
                  aria-label={`${SENTIMENT_STYLES[key].label}: ${count.toLocaleString()} calls`}
                >
                  {row}
                </Link>
              ) : (
                <div key={key} className={rowClass}>
                  {row}
                </div>
              );
            })}
          </div>
          {sentimentHref && (
            <p className="text-[10px] text-parchment/35 mt-2">
              Click a sentiment to see those calls and their summaries.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
