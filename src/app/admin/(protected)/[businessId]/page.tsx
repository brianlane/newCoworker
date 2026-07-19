import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/db/businesses";
import { getRecentLogs } from "@/lib/db/logs";
import { listSystemLogs } from "@/lib/db/system-logs";
import { getProvisioningLogs, type ProvisioningLogPayload } from "@/lib/provisioning/progress";
import { getBusinessConfig } from "@/lib/db/configs";
import { getSubscription } from "@/lib/db/subscriptions";
import { listBusinessMembers } from "@/lib/db/business-members";
import {
  getTelnyxVoiceRouteForBusiness,
  getBusinessTelnyxSettings
} from "@/lib/db/telnyx-routes";
import { formatAdminLabel, getLogBadgeVariant } from "@/lib/admin/dashboard";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { LocalTime } from "@/components/LocalTime";
import { SoulEditor } from "@/components/dashboard/SoulEditor";
import { SkipPaymentButton } from "@/components/admin/SkipPaymentButton";
import { DeleteClientButton } from "@/components/admin/DeleteClientButton";
import { ForceRefundButton } from "@/components/admin/ForceRefundButton";
import { NudgeOwnerButton } from "@/components/admin/NudgeOwnerButton";
import { StripeDiagnosticsPanel } from "@/components/admin/StripeDiagnosticsPanel";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { DeployButton } from "@/components/dashboard/DeployButton";
import { AssignDidPanel } from "@/components/admin/AssignDidPanel";
import { KillSwitch } from "@/components/dashboard/KillSwitch";
import { SafeModeToggle } from "@/components/dashboard/SafeModeToggle";
import { getTierLimits } from "@/lib/plans/limits";
import { parseEnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import { EnterpriseLimitsEditor } from "@/components/admin/EnterpriseLimitsEditor";
import { ResidencyPanel } from "@/components/admin/ResidencyPanel";
import { RcsChannelPanel } from "@/components/admin/RcsChannelPanel";
import { getChannelSettings } from "@/lib/db/channel-settings";
import { rcsTierAllowed } from "@/lib/telnyx/messaging";
import { PrivacyPanel } from "@/components/admin/PrivacyPanel";
import { DeletedItemsPanel } from "@/components/admin/DeletedItemsPanel";
import { SystemLogViewer } from "@/components/admin/SystemLogViewer";
import { NotificationMutesPanel } from "@/components/admin/NotificationMutesPanel";
import { AiFlowRunsCard } from "@/components/admin/AiFlowRunsCard";
import { HardwareSizePanel } from "@/components/admin/HardwareSizePanel";
import { ReleaseVpsPoolButton } from "@/components/admin/ReleaseVpsPoolButton";
import { WhiteGloveOffersPanel } from "@/components/admin/WhiteGloveOffersPanel";
import { ByosEnrollmentPanel } from "@/components/admin/ByosEnrollmentPanel";
import { VpsProviderPanel } from "@/components/admin/VpsProviderPanel";
import { listWhiteGloveOffers, whiteGloveOfferPayUrl } from "@/lib/db/white-glove-offers";
import { EnterpriseBillingPanel } from "@/components/admin/EnterpriseBillingPanel";
import { BrandingEditor } from "@/components/dashboard/BrandingEditor";
import { parseBranding } from "@/lib/plans/branding";
import { EnterpriseModelsEditor } from "@/components/admin/EnterpriseModelsEditor";
import { parseEnterpriseModels } from "@/lib/plans/enterprise-models";
import { ComplianceModuleEditor } from "@/components/admin/ComplianceModuleEditor";
import { parseComplianceModule } from "@/lib/compliance/module";
import { listEnterpriseDeals, enterpriseDealPayUrl } from "@/lib/db/enterprise-deals";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { byosBoxId } from "@/lib/provisioning/byos";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { getLatestVpsPostureReport } from "@/lib/db/vps-posture";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import { WebchatEnginePanel } from "@/components/admin/WebchatEnginePanel";
import { getWidgetSettingsForBusiness, webchatReplyEngine } from "@/lib/webchat/db";

export const dynamic = "force-dynamic";

export default async function BusinessDetailPage({
  params
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const [
    business,
    logs,
    recentSystemLogs,
    problemSystemLogs,
    provisioningLogs,
    config,
    subscription,
    telnyxRoute,
    telnyxSettings,
    whiteGloveOffers,
    enterpriseDeals
  ] = await Promise.all([
    getBusiness(businessId),
    getRecentLogs(businessId, 20, undefined, { excludeProvisioning: true }),
    listSystemLogs(businessId, { limit: 200 }),
    // Fetched separately so chatty debug/info traffic can never push the
    // latest warnings/errors out of the 200-row window the viewer gets.
    listSystemLogs(businessId, { minLevel: "warn", limit: 100 }),
    getProvisioningLogs(businessId, 50),
    getBusinessConfig(businessId),
    getSubscription(businessId),
    getTelnyxVoiceRouteForBusiness(businessId),
    getBusinessTelnyxSettings(businessId),
    listWhiteGloveOffers(businessId),
    listEnterpriseDeals(businessId)
  ]);
  const postureReport = await getLatestVpsPostureReport(businessId);
  const teamMembers = await listBusinessMembers(businessId);
  // Widget settings for the Web chat card. Best-effort read — the page
  // must render even if the row is missing (owner never enabled it).
  const widgetSettings = await getWidgetSettingsForBusiness(businessId).catch(() => null);
  // RCS channel wiring for the Messaging channel card. Best-effort — the
  // page must render even if the read fails (card shows defaults).
  const channelSettings = await getChannelSettings(businessId).catch(() => ({
    rcsAgentId: null,
    rcsEnabled: false
  }));

  if (!business) notFound();

  // This tenant's economics from the margin engine (same numbers as
  // /admin/costs and /admin/usage). Best effort — the page renders without
  // the card if the load fails.
  const economics = await loadFleetMargins()
    .then((data) => data.byBusiness.get(businessId) ?? null)
    .catch((err: unknown) => {
      console.error(
        "admin business: margin load failed",
        err instanceof Error ? err.message : err
      );
      return null;
    });

  // BYOS enrollment state (enterprise only): the active key row for the
  // byos-<businessId> sentinel box. Only SAFE fields cross into the client
  // component — never private_key_pem.
  const byosKeyRow =
    business.tier === "enterprise" ? await getActiveVpsSshKey(byosBoxId(businessId)) : null;
  const byosEnrollment =
    byosKeyRow && byosKeyRow.host
      ? {
          host: byosKeyRow.host,
          publicKey: byosKeyRow.public_key,
          fingerprintSha256: byosKeyRow.fingerprint_sha256,
          region: byosKeyRow.region
        }
      : null;

  const systemLogById = new Map(
    [...recentSystemLogs, ...problemSystemLogs].map((row) => [row.id, row])
  );
  const systemLogs = [...systemLogById.values()].sort((a, b) => b.id - a.id);

  const needsPayment = !subscription || subscription.status === "pending";

  return (
    <div className="space-y-6 max-w-4xl">
      {/* The action buttons never split across lines: the group is nowrap
          and, when a long business name leaves no room, drops below the
          title as one right-aligned unit (header-level flex-wrap). */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-parchment">{business.name}</h1>
            <p className="text-sm text-parchment/50">{business.owner_email}</p>
          </div>
          <StatusDot
            status={business.status as "online" | "offline" | "high_load" | "wiped"}
            showLabel
          />
          <Badge variant={business.tier === "standard" ? "online" : "neutral"}>
            {business.tier}
          </Badge>
        </div>
        <div className="ml-auto flex shrink-0 items-start gap-2">
          {/* Deploy moved off the All Clients table — offline boxes are
              (re)provisioned from here now. */}
          {business.status === "offline" && <DeployButton businessId={businessId} />}
          <ViewAsButton businessId={businessId} />
          <DeleteClientButton businessId={businessId} businessName={business.name} />
          {subscription && subscription.status === "active" && (
            <ForceRefundButton businessId={businessId} businessName={business.name} />
          )}
        </div>
      </div>

      <KillSwitch
        businessId={businessId}
        initiallyPaused={!!business.is_paused}
        compact
      />

      <SafeModeToggle
        businessId={businessId}
        initiallyEnabled={business.customer_channels_enabled === false}
        initialForwardToE164={telnyxSettings?.forward_to_e164 ?? null}
        compact
      />

      {economics && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Economics (this month)
          </h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-xs text-parchment/40 mb-0.5">Revenue rate</p>
              <p className="text-xl font-bold text-parchment">
                ${(economics.revenueCents / 100).toFixed(2)}
                <span className="text-xs text-parchment/40 font-normal">/mo</span>
              </p>
              <p className="text-xs text-parchment/30">
                {economics.revenueSource === "none"
                  ? "not paying"
                  : formatAdminLabel(economics.revenueSource)}
              </p>
            </div>
            <div>
              <p className="text-xs text-parchment/40 mb-0.5">Cost</p>
              <p className="text-xl font-bold text-parchment">
                ${(economics.costCents / 100).toFixed(2)}
                <span className="text-xs text-parchment/40 font-normal">/mo</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-parchment/40 mb-0.5">Margin</p>
              <p
                className={`text-xl font-bold ${
                  economics.marginCents >= 0 ? "text-claw-green" : "text-spark-orange"
                }`}
              >
                {economics.marginCents < 0 ? "−" : ""}$
                {Math.abs(economics.marginCents / 100).toFixed(2)}
                <span className="text-xs text-parchment/40 font-normal">/mo</span>
              </p>
            </div>
          </div>
          <ul className="divide-y divide-parchment/8">
            {economics.lines.map((line) => (
              <li key={line.key} className="py-1.5 flex items-center justify-between gap-3">
                <span className="text-xs text-parchment/70">{line.label}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <Badge variant={line.source === "actual" ? "success" : "neutral"}>
                    {line.source}
                  </Badge>
                  <span className="text-xs text-parchment font-medium">
                    ${(line.cents / 100).toFixed(2)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-parchment/30 mt-3">
            Engine: src/lib/admin/margin.ts — renewal-aware revenue, vendor actuals where synced
            (see <Link href="/admin/costs" className="hover:text-signal-teal">Costs</Link>),
            per-unit estimates otherwise. Nothing bills from this card.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Custom white-glove offers
        </h2>
        <WhiteGloveOffersPanel
          businessId={businessId}
          initialOffers={whiteGloveOffers.map((o) => ({
            id: o.id,
            name: o.name,
            description: o.description,
            amount_cents: o.amount_cents,
            status: o.status,
            created_at: o.created_at,
            paid_at: o.paid_at,
            recipient_email: o.recipient_email,
            payUrl: whiteGloveOfferPayUrl(o)
          }))}
        />
      </Card>

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Enterprise billing
          </h2>
          <EnterpriseBillingPanel
            businessId={businessId}
            currentVpsSize={resolveDeployedVpsSize(business.tier, business.vps_size)}
            initialDeals={enterpriseDeals.map((d) => ({
              id: d.id,
              setup_cents: d.setup_cents,
              monthly_cents: d.monthly_cents,
              status: d.status,
              created_at: d.created_at,
              activated_at: d.activated_at,
              payUrl: enterpriseDealPayUrl(d)
            }))}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <BrandingEditor
          businessId={businessId}
          initialBranding={parseBranding((business as { branding?: unknown }).branding)}
        />
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Custom compliance
          </h2>
          <ComplianceModuleEditor
            businessId={businessId}
            initialModule={parseComplianceModule(
              (business as { compliance_module?: unknown }).compliance_module
            )}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Models &amp; voice
          </h2>
          <EnterpriseModelsEditor
            businessId={businessId}
            initialModels={parseEnterpriseModels(
              (business as { enterprise_models?: unknown }).enterprise_models
            )}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Enterprise limits
          </h2>
          <EnterpriseLimitsEditor
            businessId={businessId}
            effectiveLimits={getTierLimits("enterprise", business.enterprise_limits)}
            initialOverride={parseEnterpriseLimitsOverride(business.enterprise_limits)}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Hosting provider &amp; region
          </h2>
          <VpsProviderPanel
            key={`${businessId}:${business.vps_provider ?? "hostinger"}:${business.vps_region ?? "us"}`}
            businessId={businessId}
            initialProvider={business.vps_provider ?? "hostinger"}
            initialRegion={business.vps_region ?? "us"}
            hasBox={!!business.hostinger_vps_id}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Bring your own server (SSH handover)
          </h2>
          <ByosEnrollmentPanel
            // Remount on tenant or enrollment change so useState re-seeds.
            key={`${businessId}:${business.vps_provider ?? "hostinger"}:${byosEnrollment?.host ?? ""}`}
            businessId={businessId}
            initialProvider={business.vps_provider ?? "hostinger"}
            initialRegion={business.vps_region ?? "us"}
            initialEnrollment={byosEnrollment}
          />
        </Card>
      )}

      {business.tier === "enterprise" && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Data residency
          </h2>
          <ResidencyPanel
            // Remount on tenant OR mode change so useState re-seeds — a
            // navigation between businesses (or a server refresh after a
            // flip) must never show the previous tenant's mode.
            key={`${businessId}:${business.data_residency_mode ?? "supabase"}`}
            businessId={businessId}
            initialMode={business.data_residency_mode ?? "supabase"}
          />
        </Card>
      )}

      {/* Privacy / data lifecycle (all tiers — retention + erasure are
          compliance levers, not enterprise features) */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Privacy / data lifecycle
        </h2>
        <PrivacyPanel
          key={`${businessId}:${business.data_retention_days ?? "none"}`}
          businessId={businessId}
          initialRetentionDays={business.data_retention_days ?? null}
        />
      </Card>

      {/* Owner-deleted items (soft deletes) — view + restore */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Deleted items
        </h2>
        <DeletedItemsPanel businessId={businessId} />
      </Card>

      {/* Team (read-only; BizBlasts' business-show "Users" panel) */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Team
        </h2>
        <ul className="divide-y divide-parchment/8">
          <li className="py-2.5 flex flex-wrap items-center gap-2">
            <span className="text-sm text-parchment font-medium">{business.owner_email}</span>
            <Badge variant="success">owner</Badge>
            <span className="text-xs text-parchment/30 ml-auto shrink-0">
              since <LocalDateTime iso={business.created_at} style="date" />
            </span>
          </li>
          {teamMembers.map((member) => (
            <li key={member.id} className="py-2.5 flex flex-wrap items-center gap-2">
              <span
                className={`text-sm font-medium ${
                  member.status === "revoked" ? "text-parchment/40 line-through" : "text-parchment"
                }`}
              >
                {member.email}
              </span>
              <Badge variant="neutral">{member.role}</Badge>
              <Badge
                variant={
                  member.status === "active"
                    ? "success"
                    : member.status === "invited"
                      ? "pending"
                      : "error"
                }
              >
                {member.status}
              </Badge>
              <span className="text-xs text-parchment/30 ml-auto shrink-0">
                {member.accepted_at ? (
                  <>
                    joined <LocalDateTime iso={member.accepted_at} style="date" />
                  </>
                ) : (
                  <>
                    invited <LocalDateTime iso={member.created_at} style="date" />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {teamMembers.length === 0 && (
          <p className="text-xs text-parchment/40 mt-2">No team members beyond the owner.</p>
        )}
      </Card>

      {/* Subscription */}
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
              Subscription
            </h2>
            {subscription ? (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <div>
                  <dt className="text-parchment/40 text-xs">Status</dt>
                  <dd>
                    <Badge
                      variant={
                        subscription.status === "active"
                          ? "success"
                          : subscription.status === "past_due"
                            ? "error"
                            : "pending"
                      }
                    >
                      {formatAdminLabel(subscription.status)}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-parchment/40 text-xs">Billing Period</dt>
                  <dd className="text-parchment capitalize">{subscription.billing_period ?? "–"}</dd>
                </div>
                <div>
                  <dt className="text-parchment/40 text-xs">Renewal</dt>
                  <dd className="text-parchment">
                    {subscription.renewal_at ? (
                      <LocalDateTime iso={subscription.renewal_at} style="date" />
                    ) : (
                      "–"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-parchment/40 text-xs">Stripe Customer</dt>
                  <dd className="text-parchment font-mono text-xs truncate max-w-[160px]">
                    {subscription.stripe_customer_id ?? "–"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-parchment/40">No subscription record found.</p>
            )}
          </div>

          {needsPayment && (
            <SkipPaymentButton businessId={businessId} />
          )}
        </div>
        {/* Nudge the owner about unfinished onboarding (checkout, website,
            unpaid offers) — the API computes the open items server-side. */}
        <div className="mt-4">
          <NudgeOwnerButton businessId={businessId} />
        </div>
      </Card>

      {/* Live-Stripe diagnostics (loaded on demand) */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Stripe diagnostics
        </h2>
        <StripeDiagnosticsPanel businessId={businessId} />
      </Card>

      {/* VPS Info */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Infrastructure
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-4">
          <div>
            <dt className="text-parchment/40 text-xs">VPS ID</dt>
            <dd className="text-parchment font-mono">{business.hostinger_vps_id ?? "–"}</dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Hardware size</dt>
            <dd className="text-parchment font-mono">
              {resolveDeployedVpsSize(business.tier, business.vps_size)}
            </dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Provider / region</dt>
            <dd className="text-parchment font-mono">
              {business.vps_provider ?? "hostinger"} · {business.vps_region ?? "us"}
            </dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Security posture</dt>
            <dd className="flex items-center gap-2">
              {postureReport ? (
                <>
                  <Badge variant={postureReport.ok ? "success" : "error"}>
                    {postureReport.ok ? "OK" : "DRIFT"}
                  </Badge>
                  <LocalTime
                    iso={postureReport.created_at}
                    className="text-xs text-parchment/40 font-mono"
                  />
                </>
              ) : (
                <span className="text-parchment/40 text-xs">no reports yet</span>
              )}
            </dd>
          </div>
        </dl>
        {postureReport && !postureReport.ok && (
          <p className="mb-4 text-xs text-spark-orange">
            Failing checks:{" "}
            {postureReport.checks
              .filter((c) => !c.ok)
              .map((c) => c.name)
              .join(", ")}
          </p>
        )}
        {!business.hostinger_vps_id &&
          subscription?.status === "active" &&
          business.status !== "wiped" &&
          (business.vps_provider ?? "hostinger") !== "byos" && (
            <div className="mb-4">
              {/* Active subscription but no box yet — the admin-created
                  enterprise path lands here (create-client writes an active
                  Stripe-less subscription without provisioning). Hidden for
                  BYOS tenants: their provisioning path is the SSH-handover
                  card above (skip-payment would run the generic purchase
                  orchestrator, which fails closed for byos). */}
              <SkipPaymentButton businessId={businessId} label="Provision VPS" />
            </div>
          )}
        {business.hostinger_vps_id &&
          (business.vps_provider ?? "hostinger") === "hostinger" && (
            /* Hardware migration is a Hostinger purchase/teardown flow —
               migrate-vps-size fails closed for BYOS/OVH tenants, so don't
               offer the panel for them (resize happens provider-side). */
            <HardwareSizePanel
              businessId={businessId}
              currentSize={resolveDeployedVpsSize(business.tier, business.vps_size)}
              pinned={business.vps_size != null}
            />
          )}
        {business.hostinger_vps_id &&
          (business.vps_provider ?? "hostinger") === "hostinger" &&
          business.status !== "wiped" && (
            /* Return the box to the adopt pool without tearing the tenant
               down now — the account is cascade-deleted when a new signup
               adopts the box. The route fail-closes on active/past_due
               subscriptions. */
            <div className="mt-4">
              <ReleaseVpsPoolButton
                businessId={businessId}
                businessName={business.name}
                vpsId={business.hostinger_vps_id}
              />
            </div>
          )}
      </Card>

      {/* Web chat widget: status + reply engine (VPS worker vs platform Gemini) */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
            Web chat
          </h2>
          {/* Admin transcript review — the only review surface for widgets
              with no tenant dashboard behind them (e.g. the direct-Gemini
              tenant serving newcoworker.com's own chat). */}
          <Link
            href={`/admin/${businessId}/webchat`}
            className="text-sm text-claw-green hover:underline"
          >
            View conversations →
          </Link>
        </div>
        <WebchatEnginePanel
          key={`${businessId}:${widgetSettings ? webchatReplyEngine(widgetSettings) : "vps"}`}
          businessId={businessId}
          initialEngine={widgetSettings ? webchatReplyEngine(widgetSettings) : "vps"}
          widgetConfigured={!!widgetSettings}
          widgetEnabled={widgetSettings?.enabled ?? false}
        />
      </Card>

      {/* Voice / SMS DID */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Voice &amp; SMS DID
        </h2>
        <AssignDidPanel
          businessId={businessId}
          currentE164={telnyxRoute?.to_e164 ?? null}
          currentBridgeOrigin={
            telnyxSettings?.bridge_media_wss_origin ?? telnyxRoute?.media_wss_origin ?? null
          }
          bridgeHeartbeatAt={telnyxSettings?.bridge_last_heartbeat_at ?? null}
          forwardToE164={telnyxSettings?.forward_to_e164 ?? null}
          transferEnabled={telnyxSettings?.transfer_enabled ?? true}
          smsFallbackEnabled={telnyxSettings?.sms_fallback_enabled ?? true}
          bridgeStaleAlertMuted={telnyxSettings?.bridge_stale_alert_muted ?? false}
          defaultAreaCode={process.env.TELNYX_DEFAULT_AREA_CODE ?? "602"}
          defaultState={process.env.TELNYX_DEFAULT_STATE ?? "AZ"}
        />
      </Card>

      {/* Messaging channel — per-tenant RCS agent + enable switch. Rendered
          for every tier (with a warning when the tier gate would demote
          sends) so an operator can stage the wiring before an upgrade. */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Messaging channel (RCS)
        </h2>
        <RcsChannelPanel
          // Remount on tenant change so useState re-seeds — navigation
          // between businesses must never show the previous tenant's values.
          // Deliberately NOT keyed on the settings values: the panel tracks
          // its own saved baseline, and a value-keyed remount after
          // router.refresh() would wipe the "Saved." confirmation.
          key={businessId}
          businessId={businessId}
          initialAgentId={channelSettings.rcsAgentId}
          initialEnabled={channelSettings.rcsEnabled}
          tierAllows={rcsTierAllowed(business.tier)}
        />
      </Card>

      {/* Soul / Identity editor */}
      {config && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Agent Configuration
          </h2>
          <SoulEditor
            businessId={businessId}
            initialSoul={config.soul_md}
            initialIdentity={config.identity_md}
          />
        </Card>
      )}

      {/* Admin dashboard mutes — fleet-feed noise control for this tenant */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Admin notification mutes
        </h2>
        <NotificationMutesPanel
          key={`${businessId}:${business.admin_mute_activity ?? false}:${business.admin_mute_errors ?? false}:${business.admin_mute_alerts ?? false}`}
          businessId={businessId}
          initialMuteActivity={business.admin_mute_activity ?? false}
          initialMuteErrors={business.admin_mute_errors ?? false}
          initialMuteAlerts={business.admin_mute_alerts ?? false}
        />
      </Card>

      {/* Unified system logs: rowboat / ollama / gemini / telnyx / aiflow / workers */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          System Logs
        </h2>
        <SystemLogViewer logs={systemLogs} />
      </Card>

      {/* AiFlow runs with per-step failure detail */}
      <AiFlowRunsCard businessId={businessId} />

      {/* Provisioning / deploy pipeline (admin-only detail) */}
      {provisioningLogs.length > 0 && (
        <Card>
          <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
            Provisioning / deploy logs
          </h2>
          <ul className="divide-y divide-parchment/10 space-y-0">
            {provisioningLogs.map((log) => {
              const p = log.log_payload as ProvisioningLogPayload;
              const src = typeof p.source === "string" ? p.source : "";
              return (
                <li key={log.id} className="py-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <LocalTime
                      iso={log.created_at}
                      className="text-xs text-parchment/45 font-mono"
                    />
                    <div className="flex items-center gap-2">
                      <Badge variant="neutral" className="text-[10px] uppercase">
                        {src}
                      </Badge>
                      <span className="text-xs text-signal-teal font-medium">{p.percent ?? "–"}%</span>
                      <Badge variant={getLogBadgeVariant(log.status)}>{formatAdminLabel(log.status)}</Badge>
                    </div>
                  </div>
                  <p className="text-sm text-parchment font-medium">{p.phase ?? log.task_type}</p>
                  <p className="text-xs text-parchment/55 whitespace-pre-wrap break-words">{p.message}</p>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-parchment/35 hover:text-parchment/50">
                      Raw payload
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-deep-ink/80 p-2 text-parchment/70 font-mono text-[10px]">
                      {JSON.stringify(log.log_payload, null, 2)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Recent Logs */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Recent Activity
        </h2>
        {logs.length === 0 ? (
          <p className="text-sm text-parchment/40">No logs yet.</p>
        ) : (
          <ul className="divide-y divide-parchment/10">
            {logs.map((log) => (
              <li key={log.id} className="flex justify-between items-center py-3">
                <div>
                  <p className="text-sm text-parchment capitalize">{formatAdminLabel(log.task_type)}</p>
                  <LocalTime iso={log.created_at} className="text-xs text-parchment/30" />
                </div>
                <Badge
                  variant={getLogBadgeVariant(log.status)}
                >
                  {formatAdminLabel(log.status)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
