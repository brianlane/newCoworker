/**
 * Business analytics (Standard/Enterprise perk, tier relaunch).
 *
 * Cards over the trailing 30 days, all derived from data other features
 * already write (no new writers, no cron):
 *   - call / text / voice-minute volume  ← daily_usage
 *   - answer rate (answered vs turned-away) ← voice_call_transcripts +
 *     system_logs `voice_call_blocked`
 *   - peak call hours (business timezone) ← voice_call_transcripts
 *   - caller sentiment mix ← the AI call-summary perk's output
 *
 * Drill-downs (all plain navigation — the page stays a server component):
 *   - `?day=YYYY-MM-DD`   — a volume-chart bar: that UTC day's totals plus
 *     its individual calls and texts, deep-linking into
 *     /dashboard/calls/[id] and /dashboard/messages/[e164].
 *   - `?sentiment=<key>`  — a sentiment row: the window's calls with that
 *     sentiment and their AI summaries.
 *   - `?hour=<0-23>`      — a peak-hours bar: the window's calls in that
 *     local-time hour.
 *
 * Starter tenants see an upgrade card instead of data — the gate is
 * server-side here, mirroring the messages/tools pattern.
 */

import { redirect } from "next/navigation";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { can } from "@/lib/authz/policy";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import {
  ANALYTICS_UPGRADE_MESSAGE,
  analyticsAllowedForTier
} from "@/lib/plans/analytics";
import {
  ANALYTICS_WINDOW_DAYS,
  analyticsWindowStart,
  CALL_SENTIMENT_KEYS,
  computePeriodChange,
  getAnalyticsDayDetail,
  getAnswerRateStats,
  getDailyUsageSeries,
  getHourCallsDetail,
  getInboundCallStats,
  getPreviousPeriodTotals,
  getSentimentCallsDetail,
  isValidAnalyticsDay,
  type DayDetailCall
} from "@/lib/analytics/dashboard-analytics";
import { getEngagementOverview } from "@/lib/analytics/engagement";
import { getLeadSourceOverview } from "@/lib/analytics/lead-sources";
import { getEmployeePerformance } from "@/lib/analytics/employee-performance";
import {
  FORECAST_MIN_DAYS,
  forecastActivity,
  getSnapshotSeries,
  type SnapshotSeriesPoint
} from "@/lib/analytics/snapshots";
import { getFlowFunnels } from "@/lib/analytics/flow-funnels";
import { getSmsLinkStats } from "@/lib/analytics/sms-link-stats";
import {
  AnswerRateCard,
  DailyVolumeCard,
  DayDetailCard,
  EmployeePerformanceCard,
  EngagementCard,
  FlowFunnelCard,
  SmsLinkStatsCard,
  LeadSourcesCard,
  PeakHoursCard,
  SegmentDetailCard,
  SentimentMixCard,
  TrendForecastCard,
  type DayDetailCallDisplayRow,
  type DayDetailTextDisplayRow,
  type TrendWeek
} from "@/components/dashboard/AnalyticsCards";
import { getRenewalPipeline } from "@/lib/analytics/renewal-pipeline";
import { getResponseTimeStats } from "@/lib/analytics/response-times";
import { getRetentionOverview } from "@/lib/analytics/retention";
import { getMonthlySummary } from "@/lib/analytics/monthly-summary";
import { getQuoteFunnel } from "@/lib/analytics/quote-funnel";
import {
  MonthlySummaryCard,
  QuoteFunnelCard,
  RenewalPipelineCard,
  ResponseTimeCard,
  RetentionCard
} from "@/components/dashboard/ReportCards";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { callerLabel } from "@/components/dashboard/voice-transcript-helpers";
import type { VoiceCallSentiment } from "@/lib/db/voice-transcripts";

export const dynamic = "force-dynamic";

const SENTIMENT_TITLES: Record<VoiceCallSentiment, string> = {
  positive: "Positive calls",
  neutral: "Neutral calls",
  negative: "Negative calls",
  mixed: "Mixed-sentiment calls"
};

/** "13" → "1 PM – 2 PM" for the hour drill-down header. */
function hourRangeLabel(hour: number): string {
  const fmt = (h: number) => {
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return `${twelve} ${h < 12 ? "AM" : "PM"}`;
  };
  return `${fmt(hour)} – ${fmt((hour + 1) % 24)}`;
}

export default async function DashboardAnalyticsPage(props: {
  searchParams?: Promise<{ day?: string; sentiment?: string; hour?: string; flowId?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/analytics");
  if (!user.email) redirect("/login?redirectTo=/dashboard/analytics");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const ctx = await resolveActiveBusinessContext(user);
  const activeBusinessId = ctx.businessId;
  // Team performance is an OWNER read (per-teammate stats are personnel
  // data); manage_billing is the owner-only capability marker.
  const isOwnerViewer = !!ctx.role && can(ctx.role, "manage_billing");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier, timezone")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });
  const business = businesses?.[0] ?? null;

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-parchment">Analytics</h1>
      <p className="text-sm text-parchment/50 mt-1">
        How your AI coworker performed over the last 30 days
      </p>
    </div>
  );

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">No coworker provisioned yet.</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Get Started →
            </a>
          </div>
        </Card>
      </div>
    );
  }

  if (!analyticsAllowedForTier(business.tier)) {
    return (
      <div className="space-y-6 max-w-4xl">
        {header}
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{ANALYTICS_UPGRADE_MESSAGE}</p>
            <a
              href="/dashboard/billing"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Upgrade to Standard →
            </a>
          </div>
        </Card>
      </div>
    );
  }

  const timeZone = (business.timezone as string | null) ?? null;

  // Drill-down params. A malformed or out-of-window value is ignored rather
  // than reaching a query — same posture as the aiflows runs page's flowId
  // guard. Only one drill-down renders at a time (day > sentiment > hour).
  const params = (await props.searchParams) ?? {};
  const now = new Date();
  const windowStartYmd = analyticsWindowStart(now, ANALYTICS_WINDOW_DAYS)
    .toISOString()
    .slice(0, 10);
  const todayYmd = now.toISOString().slice(0, 10);
  const selectedDay =
    params.day &&
    isValidAnalyticsDay(params.day) &&
    params.day >= windowStartYmd &&
    params.day <= todayYmd
      ? params.day
      : null;
  // Mutually exclusive: a hand-built URL carrying several params gets the
  // highest-priority drill-down only, so the extra fetchers never run.
  const selectedSentiment =
    !selectedDay &&
    params.sentiment &&
    (CALL_SENTIMENT_KEYS as string[]).includes(params.sentiment)
      ? (params.sentiment as VoiceCallSentiment)
      : null;
  const selectedHour =
    !selectedDay &&
    !selectedSentiment &&
    params.hour &&
    /^\d{1,2}$/.test(params.hour) &&
    Number(params.hour) <= 23
      ? Number(params.hour)
      : null;
  const selectedFlowId =
    params.flowId && /^[0-9a-f-]{36}$/i.test(params.flowId) ? params.flowId : null;

  // Lookup blips degrade a single card rather than 500-ing the whole page.
  // Every fetcher shares the page's `now` so the cards, the drill-down
  // clamps, and the chart highlights all describe the same window even if
  // UTC midnight passes mid-request.
  const [
    usage,
    answerRate,
    callStats,
    previousPeriod,
    snapshotSeries,
    engagement,
    leadSources,
    teamPerformance,
    flowFunnels,
    linkStats,
    renewalPipeline,
    responseTimes,
    retention,
    monthlySummary,
    quoteFunnel,
    dayDetail,
    sentimentDetail,
    hourDetail
  ] =
    await Promise.all([
      getDailyUsageSeries(business.id, { client: db, now }).catch(() => null),
      getAnswerRateStats(business.id, { client: db, now }).catch(() => null),
      getInboundCallStats(business.id, { client: db, timeZone, now }).catch(() => null),
      // Prior-window totals feed the "vs prior 30 days" deltas; a lookup blip
      // just hides the delta lines.
      getPreviousPeriodTotals(business.id, { client: db, now }).catch(() => null),
      // Long-window trend from the nightly snapshots (survives retention
      // pruning); a blip or an empty table just hides the trend card.
      getSnapshotSeries(business.id, 84, { client: db, now }).catch(() => null),
      // Segment counts + the quiet win-back shortlist; a blip hides the card.
      getEngagementOverview(business.id, { client: db, now }).catch(() => null),
      // Where new leads came from (channels + source tags); a blip hides it.
      getLeadSourceOverview(business.id, { client: db, now }).catch(() => null),
      // Owner-only roster leaderboard — never even fetched for team viewers.
      isOwnerViewer
        ? getEmployeePerformance(business.id, { client: db, now }).catch(() => null)
        : Promise.resolve(null),
      // Per-flow funnel; a blip hides the card.
      getFlowFunnels(business.id, { client: db, now }).catch(() => null),
      getSmsLinkStats(business.id, { client: db, now, flowId: selectedFlowId ?? undefined }).catch(
        () => null
      ),
      // Reporting suite (renewal pipeline / response times / retention /
      // monthly rollup) — each degrades to a hidden card on a blip.
      getRenewalPipeline(business.id, { client: db, now }).catch(() => null),
      getResponseTimeStats(business.id, { client: db, now }).catch(() => null),
      getRetentionOverview(business.id, { client: db, now }).catch(() => null),
      getMonthlySummary(business.id, { client: db, now }).catch(() => null),
      // Quote-stage tag funnel; a blip hides the card.
      getQuoteFunnel(business.id, { client: db }).catch(() => null),
      selectedDay
        ? getAnalyticsDayDetail(business.id, selectedDay, { client: db }).catch(() => null)
        : Promise.resolve(null),
      selectedSentiment
        ? getSentimentCallsDetail(business.id, selectedSentiment, { client: db, now }).catch(
            () => null
          )
        : Promise.resolve(null),
      selectedHour !== null
        ? getHourCallsDetail(business.id, selectedHour, { client: db, timeZone, now }).catch(
            () => null
          )
        : Promise.resolve(null)
    ]);
  const segmentDetail = sentimentDetail ?? hourDetail;

  // Deltas only when NEITHER window's transcript scan hit its row cap — a
  // capped scan undercounts, so a percentage against it would be wrong, not
  // merely incomplete (the answer-rate card suppresses for the same reason).
  const comparablePeriod =
    previousPeriod && !previousPeriod.clipped && usage && !usage.clipped
      ? previousPeriod
      : null;

  // Trend & forecast card: only once enough snapshot history exists for the
  // math to mean anything (FORECAST_MIN_DAYS).
  const showTrend = (snapshotSeries?.coveredDays ?? 0) >= FORECAST_MIN_DAYS;
  const trendWeeks: TrendWeek[] = [];
  let callForecast = null;
  let textForecast = null;
  if (showTrend && snapshotSeries) {
    const points = snapshotSeries.points;
    for (let i = 0; i < points.length; i += 7) {
      const week = points.slice(i, i + 7);
      trendWeeks.push({
        label: new Date(`${week[0].date}T00:00:00Z`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC"
        }),
        calls: week.reduce((s: number, p: SnapshotSeriesPoint) => s + p.calls, 0),
        sms: week.reduce((s: number, p: SnapshotSeriesPoint) => s + p.smsSent, 0)
      });
    }
    // Forecast over the covered tail only — leading zero-filled days from
    // before snapshots began would fake a growth trend.
    const firstCovered = points.findIndex((p) => p.calls > 0 || p.smsSent > 0 || p.voiceMinutes > 0);
    const tail = firstCovered >= 0 ? points.slice(firstCovered) : points;
    callForecast = forecastActivity(tail.map((p) => p.calls));
    textForecast = forecastActivity(tail.map((p) => p.smsSent));
  }

  // Name known callers (owner / roster / manual overrides) across every
  // drill-down list, mirroring the call-history page. One lookup covers the
  // day's calls + texts and the sentiment/hour segment.
  const segmentCallRows = segmentDetail?.calls ?? [];
  const nameNumbers = [
    ...(dayDetail?.calls ?? []).map((c) => c.callerE164),
    ...(dayDetail?.texts ?? []).map((t) => t.otherE164),
    ...segmentCallRows.map((c) => c.callerE164)
  ].filter((p): p is string => Boolean(p));
  const contactNames =
    nameNumbers.length > 0
      ? await resolveContactNames(business.id, nameNumbers, db).catch(
          () => new Map<string, ContactName>()
        )
      : new Map<string, ContactName>();
  const toDisplayCall = (call: DayDetailCall): DayDetailCallDisplayRow => {
    const contact = call.callerE164 ? contactNames.get(call.callerE164) : undefined;
    return {
      ...call,
      label: contact?.name ?? callerLabel(call.callerE164),
      badgeKind:
        contact?.kind === "employee" ? "employee" : contact?.kind === "owner" ? "owner" : null
    };
  };
  const dayCalls = (dayDetail?.calls ?? []).map(toDisplayCall);
  const segmentCalls = segmentCallRows.map(toDisplayCall);
  const dayTexts: DayDetailTextDisplayRow[] = (dayDetail?.texts ?? []).map((text) => ({
    ...text,
    label:
      (text.otherE164 ? contactNames.get(text.otherE164)?.name : undefined) ??
      callerLabel(text.otherE164)
  }));

  return (
    <div className="space-y-6 max-w-4xl">
      {header}

      {usage ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <DailyVolumeCard
              label="Calls (30 days)"
              unit="calls"
              total={usage.totals.calls}
              days={usage.days}
              value={(p) => p.calls}
              colorClass="bg-signal-teal/70"
              dayHref={(date) => `/dashboard/analytics?day=${date}#day-detail`}
              selectedDate={selectedDay}
              change={
                comparablePeriod
                  ? computePeriodChange(usage.totals.calls, comparablePeriod.calls)
                  : null
              }
            />
            <DailyVolumeCard
              label="Texts (30 days)"
              unit="texts"
              total={usage.totals.sms}
              days={usage.days}
              value={(p) => p.sms}
              colorClass="bg-claw-green/70"
              dayHref={(date) => `/dashboard/analytics?day=${date}#day-detail`}
              selectedDate={selectedDay}
              change={
                comparablePeriod
                  ? computePeriodChange(usage.totals.sms, comparablePeriod.sms)
                  : null
              }
            />
            <DailyVolumeCard
              label="Voice minutes (30 days)"
              unit="min"
              total={usage.totals.voiceMinutes}
              days={usage.days}
              value={(p) => p.voiceMinutes}
              colorClass="bg-amber-300/60"
              dayHref={(date) => `/dashboard/analytics?day=${date}#day-detail`}
              selectedDate={selectedDay}
              change={
                comparablePeriod
                  ? computePeriodChange(usage.totals.voiceMinutes, comparablePeriod.voiceMinutes)
                  : null
              }
            />
          </div>
          <p className="text-xs text-parchment/40 -mt-3">
            Click a day in any chart to see that day&apos;s calls, texts, and totals.
            {usage.clipped ? " Call counts cover the most recent calls only." : ""}
          </p>
        </>
      ) : (
        <Card>
          <p className="text-sm text-parchment/50">Usage data is temporarily unavailable.</p>
        </Card>
      )}

      {selectedDay &&
        (dayDetail ? (
          <DayDetailCard
            detail={dayDetail}
            calls={dayCalls}
            texts={dayTexts}
            closeHref="/dashboard/analytics"
          />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Day detail is temporarily unavailable.{" "}
              <a href="/dashboard/analytics" className="underline hover:text-parchment">
                Back to 30 days
              </a>
            </p>
          </Card>
        ))}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {answerRate ? (
          <AnswerRateCard
            answered={answerRate.answered}
            missed={answerRate.missed}
            rate={answerRate.rate}
            previousRate={previousPeriod?.answerRate ?? null}
          />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Answer-rate data is temporarily unavailable.
            </p>
          </Card>
        )}
        {callStats ? (
          <SentimentMixCard
            sentiment={callStats.sentiment}
            total={callStats.sentimentTotal}
            sentimentHref={(key) => `/dashboard/analytics?sentiment=${key}#segment-detail`}
            selectedSentiment={selectedSentiment}
          />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Sentiment data is temporarily unavailable.
            </p>
          </Card>
        )}
      </div>

      {showTrend && (
        <TrendForecastCard weeks={trendWeeks} calls={callForecast} texts={textForecast} />
      )}

      {flowFunnels && flowFunnels.rows.length > 0 && (
        <FlowFunnelCard rows={flowFunnels.rows} clipped={flowFunnels.clipped} />
      )}

      {linkStats && linkStats.links.length > 0 && (
        <SmsLinkStatsCard
          businessId={business.id}
          links={linkStats.links}
          clipped={linkStats.clipped}
          flowFilterName={
            selectedFlowId
              ? flowFunnels?.rows.find((r) => r.flowId === selectedFlowId)?.flowName ?? selectedFlowId
              : null
          }
        />
      )}

      <p className="text-xs text-parchment/40">
        Export CSV:{" "}
        <a
          href={`/api/dashboard/analytics/export?businessId=${business.id}&kind=daily`}
          className="text-signal-teal hover:underline"
        >
          daily volume
        </a>
        {" · "}
        <a
          href={`/api/dashboard/analytics/export?businessId=${business.id}&kind=flows`}
          className="text-signal-teal hover:underline"
        >
          flow performance
        </a>
        {" · "}
        <a
          href={`/api/dashboard/analytics/export?businessId=${business.id}&kind=links${selectedFlowId ? `&flowId=${selectedFlowId}` : ""}`}
          className="text-signal-teal hover:underline"
        >
          tracked links
        </a>
        {" · "}
        <a
          href={`/api/dashboard/analytics/export?businessId=${business.id}&kind=link_clicks${selectedFlowId ? `&flowId=${selectedFlowId}` : ""}`}
          className="text-signal-teal hover:underline"
        >
          link clicks
        </a>
      </p>

      {callStats && (
        <PeakHoursCard
          hourBuckets={callStats.hourBuckets}
          callCount={callStats.callCount}
          clipped={callStats.clipped}
          timeZoneLabel={timeZone ?? "UTC"}
          hourHref={(hour) => `/dashboard/analytics?hour=${hour}#segment-detail`}
          selectedHour={selectedHour}
        />
      )}

      {engagement && engagement.total > 0 && <EngagementCard view={engagement} />}

      {leadSources && leadSources.totalNewContacts > 0 && (
        <LeadSourcesCard view={leadSources} />
      )}

      {renewalPipeline &&
        (renewalPipeline.rows.length > 0 ||
          Object.values(renewalPipeline.counts).some((c) => c > 0)) && (
          <RenewalPipelineCard pipeline={renewalPipeline} />
        )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {responseTimes && (responseTimes.repliedCount > 0 || responseTimes.deadLetterCount > 0) && (
          <ResponseTimeCard stats={responseTimes} />
        )}
        {retention && retention.engagedEver > 0 && <RetentionCard retention={retention} />}
      </div>

      {quoteFunnel && quoteFunnel.totalTracked > 0 && <QuoteFunnelCard funnel={quoteFunnel} />}

      {monthlySummary &&
        (monthlySummary.current.coveredDays > 0 || monthlySummary.previous.coveredDays > 0) && (
          <MonthlySummaryCard summary={monthlySummary} />
        )}

      {teamPerformance && teamPerformance.length > 0 && (
        <EmployeePerformanceCard rows={teamPerformance} />
      )}

      {(selectedSentiment || selectedHour !== null) &&
        (segmentDetail ? (
          <SegmentDetailCard
            title={
              selectedSentiment
                ? SENTIMENT_TITLES[selectedSentiment]
                : `Calls between ${hourRangeLabel(selectedHour as number)}`
            }
            subtitle={
              selectedSentiment
                ? "Sentiment detail (30 days)"
                : `Hour detail (30 days) · ${timeZone ?? "UTC"}`
            }
            calls={segmentCalls}
            turnedAway={hourDetail && !selectedSentiment ? hourDetail.turnedAway : undefined}
            clipped={segmentDetail.clipped}
            closeHref="/dashboard/analytics"
          />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Call detail is temporarily unavailable.{" "}
              <a href="/dashboard/analytics" className="underline hover:text-parchment">
                Back to 30 days
              </a>
            </p>
          </Card>
        ))}
    </div>
  );
}
