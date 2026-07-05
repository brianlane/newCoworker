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
 * Starter tenants see an upgrade card instead of data — the gate is
 * server-side here, mirroring the messages/tools pattern.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import {
  ANALYTICS_UPGRADE_MESSAGE,
  analyticsAllowedForTier
} from "@/lib/plans/analytics";
import {
  getAnswerRateStats,
  getDailyUsageSeries,
  getInboundCallStats
} from "@/lib/analytics/dashboard-analytics";
import {
  AnswerRateCard,
  DailyVolumeCard,
  PeakHoursCard,
  SentimentMixCard
} from "@/components/dashboard/AnalyticsCards";

export const dynamic = "force-dynamic";

export default async function DashboardAnalyticsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/analytics");
  if (!user.email) redirect("/login?redirectTo=/dashboard/analytics");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier, timezone")
    .eq("owner_email", ownerEmail)
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
  // Lookup blips degrade a single card rather than 500-ing the whole page.
  const [usage, answerRate, callStats] = await Promise.all([
    getDailyUsageSeries(business.id, { client: db }).catch(() => null),
    getAnswerRateStats(business.id, { client: db }).catch(() => null),
    getInboundCallStats(business.id, { client: db, timeZone }).catch(() => null)
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      {header}

      {usage ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <DailyVolumeCard
            label="Calls (30 days)"
            unit="calls"
            total={usage.totals.calls}
            days={usage.days}
            value={(p) => p.calls}
            colorClass="bg-signal-teal/70"
          />
          <DailyVolumeCard
            label="Texts (30 days)"
            unit="texts"
            total={usage.totals.sms}
            days={usage.days}
            value={(p) => p.sms}
            colorClass="bg-claw-green/70"
          />
          <DailyVolumeCard
            label="Voice minutes (30 days)"
            unit="min"
            total={usage.totals.voiceMinutes}
            days={usage.days}
            value={(p) => p.voiceMinutes}
            colorClass="bg-amber-300/60"
          />
        </div>
      ) : (
        <Card>
          <p className="text-sm text-parchment/50">Usage data is temporarily unavailable.</p>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {answerRate ? (
          <AnswerRateCard
            answered={answerRate.answered}
            missed={answerRate.missed}
            rate={answerRate.rate}
          />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Answer-rate data is temporarily unavailable.
            </p>
          </Card>
        )}
        {callStats ? (
          <SentimentMixCard sentiment={callStats.sentiment} total={callStats.sentimentTotal} />
        ) : (
          <Card>
            <p className="text-sm text-parchment/50">
              Sentiment data is temporarily unavailable.
            </p>
          </Card>
        )}
      </div>

      {callStats && (
        <PeakHoursCard
          hourBuckets={callStats.hourBuckets}
          callCount={callStats.callCount}
          clipped={callStats.clipped}
          timeZoneLabel={timeZone ?? "UTC"}
        />
      )}
    </div>
  );
}
