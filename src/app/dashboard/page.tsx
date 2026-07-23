import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
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
  const t = await getTranslations("dashboard.home");
  const tBadge = await getTranslations("dashboard.activityBadge");
  const locale = (await getLocale()) as AppLocale;
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");
  if (!user.email) redirect("/login?redirectTo=/dashboard");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, name, owner_email, status, tier, enterprise_limits, is_paused, customer_channels_enabled, created_at"
    )
    .in("id", activeBusinessId ? [activeBusinessId] : [])
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
      getRecentActivity(business.id, 10, undefined, business.tier),
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

  // Verification status. The auth user's `email_confirmed_at` is
  // authoritative — a signed-in owner whose auth email is confirmed is
  // verified, full stop. Only when auth hasn't confirmed it do we fall back
  // to `customer_profiles.email_verified_at` ("the human pressed the
  // verification link"). Checking the profile FIRST caused a false banner:
  // a later checkout/change-plan can upsert a fresh profile row (with a
  // null `email_verified_at`) for a long-verified account. On a transient
  // lookup error we treat the email as already verified to avoid spuriously
  // rendering the banner during a Supabase blip on every dashboard load.
  let emailVerified = true;
  if (!user.emailConfirmedAt) {
    try {
      const profile = await getCustomerProfileByEmail(user.email);
      if (profile && !profile.email_verified_at) emailVerified = false;
    } catch {
      emailVerified = true;
    }
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
        <h1 className="text-2xl font-bold text-parchment">{t("title")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("subtitle")}</p>
      </div>

      {!emailVerified && <UnverifiedEmailBanner email={user.email} />}

      {!business ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              {t("getStarted")}
            </a>
          </div>
        </Card>
      ) : (
        <>
          {business.is_paused && (
            <Card className="border-spark-orange/50 bg-spark-orange/10">
              <p className="text-sm font-semibold text-spark-orange">{t("pausedTitle")}</p>
              <p className="text-xs text-parchment/60 mt-1">{t("pausedBody")}</p>
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
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">{t("coworkerStatus")}</p>
              <div className="flex flex-col gap-1">
                {business.is_paused ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="error">{t("paused")}</Badge>
                    <span className="text-xs text-parchment/45 capitalize">
                      {t("infra", { status: business.status.replace("_", " ") })}
                    </span>
                  </div>
                ) : business.customer_channels_enabled === false ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="pending">{t("safeMode")}</Badge>
                    <span className="text-xs text-parchment/45 capitalize">
                      {t("infra", { status: business.status.replace("_", " ") })}
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
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">{t("plan")}</p>
              <Badge variant={business.tier === "starter" ? "neutral" : "online"}>
                {business.tier.charAt(0).toUpperCase() + business.tier.slice(1)}
              </Badge>
              <p className="mt-2 text-xs text-parchment/50 leading-relaxed">
                {voiceSnapshot
                  ? t("voiceUsage", {
                      used: Math.round(voiceSnapshot.committedIncludedSeconds / 60).toLocaleString(),
                      cap: Math.round(voiceSnapshot.tierCapSeconds / 60).toLocaleString()
                    })
                  : voiceMinutesLine(
                      business.tier as PlanTier,
                      business.tier === "enterprise" ? business.enterprise_limits : undefined,
                      locale
                    )}
                <br />
                {smsUsedThisMonth !== null && smsCap !== null && Number.isFinite(smsCap)
                  ? t("textsUsage", {
                      used: smsUsedThisMonth.toLocaleString(),
                      cap: smsCap.toLocaleString()
                    })
                  : smsMonthlyLine(
                      business.tier as PlanTier,
                      business.tier === "enterprise" ? business.enterprise_limits : undefined,
                      locale
                    )}
                {chatSpend && (
                  <>
                    <br />
                    {t("aiBudgetUsage", {
                      spent: `$${(chatSpend.spendMicros / 1_000_000).toFixed(2)}`,
                      cap: `$${(chatSpend.effectiveCapMicros / 1_000_000).toFixed(2)}`
                    })}
                  </>
                )}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">{t("business")}</p>
              <p className="font-semibold text-parchment truncate">{business.name}</p>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-parchment/60 uppercase tracking-wider">
                {t("recentActivity")}
              </h2>
              <a
                href="/dashboard/activity"
                className="text-xs font-medium text-signal-teal hover:underline"
              >
                {t("seeAllActivity")}
              </a>
            </div>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-parchment/40">{t("noActivity")}</p>
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
                      <span className="flex shrink-0 items-center gap-2">
                        {/* Flow-sent messages carry the green AiFlow origin
                            chip next to their kind badge. */}
                        {item.origin === "aiflow" && (
                          <Badge variant={ACTIVITY_BADGE.aiflow.variant}>
                            {tBadge(ACTIVITY_BADGE.aiflow.labelKey)}
                          </Badge>
                        )}
                        <Badge variant={ACTIVITY_BADGE[item.kind].variant}>
                          {tBadge(ACTIVITY_BADGE[item.kind].labelKey)}
                        </Badge>
                      </span>
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
                <p className="font-semibold text-signal-teal text-sm">{t("viewMemory")}</p>
                <p className="text-xs text-parchment/40 mt-1">{t("viewMemoryBlurb")}</p>
              </Card>
            </a>
            <Link href="/dashboard/integrations" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">{t("integrations")}</p>
                <p className="text-xs text-parchment/40 mt-1">{t("integrationsBlurb")}</p>
              </Card>
            </Link>
            <a href="/dashboard/notifications" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">{t("notifications")}</p>
                <p className="text-xs text-parchment/40 mt-1">{t("notificationsBlurb")}</p>
              </Card>
            </a>
            <a href="/dashboard/billing" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">{t("billing")}</p>
                <p className="text-xs text-parchment/40 mt-1">{t("billingBlurb")}</p>
              </Card>
            </a>
            <a href="/dashboard/settings" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">{t("accountSettings")}</p>
                <p className="text-xs text-parchment/40 mt-1">{t("accountSettingsBlurb")}</p>
              </Card>
            </a>
          </div>
        </>
      )}
    </div>
  );
}
