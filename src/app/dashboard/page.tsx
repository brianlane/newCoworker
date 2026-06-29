import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getRecentActivity, type ActivityItem } from "@/lib/db/activity";
import { ACTIVITY_BADGE } from "@/components/dashboard/activity-badge";
import {
  getLatestProvisioningStatus,
  shouldMountProvisioningWidget,
  shouldShowProvisioningProgress
} from "@/lib/provisioning/progress";
import {
  getTelnyxVoiceRouteForBusiness,
  getBusinessTelnyxSettings
} from "@/lib/db/telnyx-routes";
import { CoworkerProvisioningProgress } from "@/components/dashboard/CoworkerProvisioningProgress";
import { PhoneNumberCard } from "@/components/dashboard/PhoneNumberCard";
import { UnverifiedEmailBanner } from "@/components/dashboard/UnverifiedEmailBanner";
import { getCustomerProfileByEmail } from "@/lib/db/customer-profiles";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { KillSwitch } from "@/components/dashboard/KillSwitch";
import { SafeModeToggle } from "@/components/dashboard/SafeModeToggle";
import { StaffSmsToggle } from "@/components/dashboard/StaffSmsToggle";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import { getCalendarMonthUsageTotals } from "@/lib/db/usage";
import { getTierLimits } from "@/lib/plans/limits";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");
  if (!user.email) redirect("/login?redirectTo=/dashboard");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, name, owner_email, status, tier, enterprise_limits, is_paused, customer_channels_enabled, created_at"
    )
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  let recentActivity: ActivityItem[] = [];
  let latestProvisioning = null;
  let telnyxRoute: Awaited<ReturnType<typeof getTelnyxVoiceRouteForBusiness>> = null;
  let telnyxSettings: Awaited<ReturnType<typeof getBusinessTelnyxSettings>> = null;
  // Voice / SMS / AI usage shown on the Plan card, mirroring the Billing page
  // sources so the caps and consumption match. All non-fatal: a lookup blip
  // falls back to the static plan copy rather than blanking the dashboard.
  let chatSpend: Awaited<ReturnType<typeof getChatSpendSnapshotForBusiness>> | null = null;
  let voiceSnapshot: Awaited<ReturnType<typeof getVoiceBillingSnapshotForBusiness>> | null = null;
  let smsUsedThisMonth: number | null = null;
  if (business) {
    [
      recentActivity,
      latestProvisioning,
      telnyxRoute,
      telnyxSettings,
      chatSpend,
      voiceSnapshot,
      smsUsedThisMonth
    ] = await Promise.all([
      getRecentActivity(business.id, 10),
      getLatestProvisioningStatus(business.id),
      getTelnyxVoiceRouteForBusiness(business.id),
      getBusinessTelnyxSettings(business.id),
      getChatSpendSnapshotForBusiness(
        business.id,
        db,
        (business.tier ?? null) as PlanTier | null
      ).catch(() => null),
      getVoiceBillingSnapshotForBusiness(business.id).catch(() => null),
      getCalendarMonthUsageTotals(business.id, db)
        .then((t) => t.sms_sent)
        .catch(() => null)
    ]);
  }

  // SMS monthly cap for the tier (Infinity for enterprise → show static copy).
  const smsCap =
    business?.tier
      ? getTierLimits(
          business.tier as PlanTier,
          business.tier === "enterprise" ? business.enterprise_limits : undefined
        ).smsPerMonth
      : null;

  // Pull verification status from `customer_profiles` (the single
  // source of truth for "the human pressed the verification link in
  // their inbox" — see `customer_profiles.email_verified_at` in
  // migration 20260505000000). On a transient lookup error we treat
  // the email as already verified to avoid spuriously rendering the
  // banner during a Supabase blip on every dashboard load.
  let emailVerified = true;
  try {
    const profile = await getCustomerProfileByEmail(user.email);
    if (profile && !profile.email_verified_at) emailVerified = false;
  } catch {
    emailVerified = true;
  }

  const showProvisioningWidget =
    business !== null && shouldMountProvisioningWidget(business.status, latestProvisioning);

  const provisioningInitialSnapshot =
    business !== null && latestProvisioning !== null
      ? {
          percent: latestProvisioning.percent,
          complete: !shouldShowProvisioningProgress(business.status, latestProvisioning),
          failed: latestProvisioning.logStatus === "error"
        }
      : undefined;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Your AI Coworker</h1>
        <p className="text-sm text-parchment/50 mt-1">Monitor and manage your digital employee</p>
      </div>

      {!emailVerified && <UnverifiedEmailBanner email={user.email} />}

      {!business ? (
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
      ) : (
        <>
          {business.is_paused && (
            <Card className="border-spark-orange/50 bg-spark-orange/10">
              <p className="text-sm font-semibold text-spark-orange">Coworker is paused</p>
              <p className="text-xs text-parchment/60 mt-1">
                Automation is stopped. Use Resume below when you want your AI coworker active again.
              </p>
            </Card>
          )}

          {showProvisioningWidget && (
            <CoworkerProvisioningProgress
              businessId={business.id}
              initialSnapshot={provisioningInitialSnapshot}
            />
          )}

          <Card>
            <PhoneNumberCard
              e164={telnyxRoute?.to_e164 ?? null}
              bridgeHeartbeatAt={telnyxSettings?.bridge_last_heartbeat_at ?? null}
              forwardToE164={telnyxSettings?.forward_to_e164 ?? null}
              transferEnabled={telnyxSettings?.transfer_enabled ?? true}
              smsCampaignStatus={telnyxSettings?.telnyx_messaging_campaign_status ?? null}
            />
          </Card>

          {/* Status Card */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">Coworker Status</p>
              <div className="flex flex-col gap-1">
                {business.is_paused ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="error">Paused</Badge>
                    <span className="text-xs text-parchment/45 capitalize">
                      Infra: {business.status.replace("_", " ")}
                    </span>
                  </div>
                ) : business.customer_channels_enabled === false ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="pending">Safe mode</Badge>
                    <span className="text-xs text-parchment/45 capitalize">
                      Infra: {business.status.replace("_", " ")}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <StatusDot status={business.status as "online" | "offline" | "high_load"} />
                    <span className="font-semibold capitalize">{business.status.replace("_", " ")}</span>
                  </div>
                )}
              </div>
            </Card>
            <Card>
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">Plan</p>
              <Badge variant={business.tier === "starter" ? "neutral" : "online"}>
                {business.tier.charAt(0).toUpperCase() + business.tier.slice(1)}
              </Badge>
              <p className="mt-2 text-xs text-parchment/50 leading-relaxed">
                {voiceSnapshot
                  ? `Voice ${Math.round(
                      voiceSnapshot.committedIncludedSeconds / 60
                    ).toLocaleString()} / ${Math.round(
                      voiceSnapshot.tierCapSeconds / 60
                    ).toLocaleString()} min`
                  : voiceMinutesLine(
                      business.tier as PlanTier,
                      business.tier === "enterprise" ? business.enterprise_limits : undefined
                    )}
                <br />
                {smsUsedThisMonth !== null && smsCap !== null && Number.isFinite(smsCap)
                  ? `Texts ${smsUsedThisMonth.toLocaleString()} / ${smsCap.toLocaleString()} this month`
                  : smsMonthlyLine(
                      business.tier as PlanTier,
                      business.tier === "enterprise" ? business.enterprise_limits : undefined
                    )}
                {chatSpend && (
                  <>
                    <br />
                    {`AI budget $${(chatSpend.spendMicros / 1_000_000).toFixed(2)} / $${(
                      chatSpend.effectiveCapMicros / 1_000_000
                    ).toFixed(2)}`}
                  </>
                )}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">Business</p>
              <p className="font-semibold text-parchment truncate">{business.name}</p>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-parchment/60 uppercase tracking-wider">
                Recent Activity
              </h2>
              <a
                href="/dashboard/activity"
                className="text-xs font-medium text-signal-teal hover:underline"
              >
                See all activity →
              </a>
            </div>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-parchment/40">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-parchment/10">
                {recentActivity.map((item) => (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      className="flex items-center justify-between gap-3 py-3 group"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-parchment truncate group-hover:text-signal-teal transition-colors">
                          {item.label}
                        </p>
                        <p className="text-xs text-parchment/40">
                          <LocalDateTime iso={item.at} />
                        </p>
                      </div>
                      <Badge variant={ACTIVITY_BADGE[item.kind].variant}>
                        {ACTIVITY_BADGE[item.kind].label}
                      </Badge>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <KillSwitch businessId={business.id} initiallyPaused={!!business.is_paused} />

          <SafeModeToggle
            businessId={business.id}
            initiallyEnabled={business.customer_channels_enabled === false}
            initialForwardToE164={telnyxSettings?.forward_to_e164 ?? null}
          />

          <StaffSmsToggle
            businessId={business.id}
            initialAssistantReplyEnabled={
              telnyxSettings?.staff_sms_assistant_reply_enabled ?? true
            }
            initialForwardToOwnerEnabled={
              telnyxSettings?.staff_sms_forward_to_owner_enabled ?? false
            }
          />

          {/* Quick Links */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <a href="/dashboard/memory" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">View Memory →</p>
                <p className="text-xs text-parchment/40 mt-1">Review what your coworker has learned</p>
              </Card>
            </a>
            <a href="/dashboard/integrations" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Integrations →</p>
                <p className="text-xs text-parchment/40 mt-1">Connections and platform settings</p>
              </Card>
            </a>
            <a href="/dashboard/notifications" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Notifications →</p>
                <p className="text-xs text-parchment/40 mt-1">Configure SMS and email alerts</p>
              </Card>
            </a>
            <a href="/dashboard/billing" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Billing →</p>
                <p className="text-xs text-parchment/40 mt-1">Voice minutes and top-ups</p>
              </Card>
            </a>
            <a href="/dashboard/settings" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Account Settings →</p>
                <p className="text-xs text-parchment/40 mt-1">Account and preferences</p>
              </Card>
            </a>
          </div>
        </>
      )}
    </div>
  );
}
