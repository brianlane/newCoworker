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
import { PaymentLinkButton } from "@/components/admin/PaymentLinkButton";
import { ForceRefundButton } from "@/components/admin/ForceRefundButton";
import { BillingControlsPanel } from "@/components/admin/BillingControlsPanel";
import { MembershipDiscountPanel } from "@/components/admin/MembershipDiscountPanel";
import { NudgeOwnerButton } from "@/components/admin/NudgeOwnerButton";
import { computeOnboardingNudgeItems } from "@/lib/admin/onboarding-nudge";
import { StripeDiagnosticsPanel } from "@/components/admin/StripeDiagnosticsPanel";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { DeployButton } from "@/components/dashboard/DeployButton";
import { AssignDidPanel } from "@/components/admin/AssignDidPanel";
import { translatorAllowedForTier } from "@/lib/plans/translator";
import { KillSwitch } from "@/components/dashboard/KillSwitch";
import { SafeModeToggle } from "@/components/dashboard/SafeModeToggle";
import { getTierLimits } from "@/lib/plans/limits";
import { parseEnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import { EnterpriseLimitsEditor } from "@/components/admin/EnterpriseLimitsEditor";
import { ResidencyPanel } from "@/components/admin/ResidencyPanel";
import { RcsChannelPanel } from "@/components/admin/RcsChannelPanel";
import { getChannelSettings } from "@/lib/db/channel-settings";
import { ContactFormSinkPanel } from "@/components/admin/ContactFormSinkPanel";
import { getContactFormSinkBusinessId } from "@/lib/db/contact-form-sink";
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
import { PrioritySupportPanel } from "@/components/admin/PrioritySupportPanel";
import { getLivePrioritySupportSubscription } from "@/lib/db/priority-support";
import {
  PRIORITY_SUPPORT_MONTHLY_CENTS,
  prioritySupportDaysLeft,
  prioritySupportStatus
} from "@/lib/plans/priority-support";
import { formatPriceCents } from "@/lib/pricing";
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
import { peakLoadPerCore } from "@/lib/vps/host-metrics";
import { listHostingerVpsCostsByVmId } from "@/lib/db/platform-costs";
import { pickLiveBoxSnapshot, summarizeBoxTerm, boxSnapshotStale } from "@/lib/vps/box-term";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import { WebchatEnginePanel } from "@/components/admin/WebchatEnginePanel";
import { getWidgetSettingsForBusiness, webchatReplyEngine } from "@/lib/webchat/db";
import { MemoryGraphPanel } from "@/components/admin/MemoryGraphPanel";
import {
  MEMORY_GRAPH_DEFAULT_MODE_KEY,
  MEMORY_GRAPH_FALLBACK_DEFAULT,
  effectiveMemoryGraphMode
} from "@/lib/memory/graph-db";
import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { getKgAdminSummary } from "@/lib/memory/kg-events";

export const dynamic = "force-dynamic";

export default async function BusinessDetailPage({
  params
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
    // Junk in the segment (a mistyped URL) must 404, not crash the page
    // when Postgres refuses the uuid cast.
    notFound();
  }
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
    enterpriseDeals,
    prioritySupportRow
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
    listEnterpriseDeals(businessId),
    getLivePrioritySupportSubscription(businessId).catch(() => null)
  ]);
  const postureReport = await getLatestVpsPostureReport(businessId);
  // When this box's paid period ends. Read from the daily Hostinger billing
  // snapshot rather than the live API: the admin page must not block on a
  // vendor call, and /admin/costs already keeps this table fresh. Best
  // effort and one row at most, a missing or unreadable snapshot degrades
  // the field to "no billing snapshot", never errors the page.
  const boxVmId = Number(business?.hostinger_vps_id ?? "");
  const boxBillingRows = Number.isFinite(boxVmId) && boxVmId > 0
    ? await listHostingerVpsCostsByVmId(boxVmId).catch(
        (err: unknown) => {
          console.error(
            "admin business: hostinger billing snapshot read failed",
            err instanceof Error ? err.message : err
          );
          return [];
        }
      )
    : [];
  const boxBilling = pickLiveBoxSnapshot(boxBillingRows);
  const boxTerm = boxBilling ? summarizeBoxTerm(boxBilling) : null;
  const boxSnapshotAt = boxBilling?.snapshot_at ?? null;
  const boxSnapshotIsStale = boxSnapshotAt !== null && boxSnapshotStale(boxSnapshotAt);
  const teamMembers = await listBusinessMembers(businessId);
  // Widget settings for the Web chat card. Best-effort read, the page
  // must render even if the row is missing (owner never enabled it).
  const widgetSettings = await getWidgetSettingsForBusiness(businessId).catch(() => null);
  // RCS channel wiring for the Messaging channel card. Best-effort, the
  // page must render even if the read fails (card shows defaults).
  const channelSettings = await getChannelSettings(businessId).catch(() => ({
    rcsAgentId: null,
    rcsEnabled: false
  }));
  // Platform contact-form sink designation. Best-effort, defaults to "no
  // sink anywhere" when the read fails so the page still renders.
  const contactFormSinkBusinessId = await getContactFormSinkBusinessId().catch(
    () => null
  );
  // Knowledge-graph card data. Best-effort, the page must render even if
  // the graph tables are unreadable (card shows zeros). The fleet default
  // is read FRESH (not through the resolver's ~60s cache) so the card can
  // never disagree with /admin/memory-graph within one browsing session.
  const kgDefaultRaw = await getAdminPlatformSetting(MEMORY_GRAPH_DEFAULT_MODE_KEY).catch(
    () => null
  );
  const kgFleetDefault =
    kgDefaultRaw === "off" || kgDefaultRaw === "shadow" || kgDefaultRaw === "active"
      ? kgDefaultRaw
      : MEMORY_GRAPH_FALLBACK_DEFAULT;
  const kgEffectiveMode = effectiveMemoryGraphMode(config?.memory_graph_mode, kgFleetDefault);
  const kgSummary = await getKgAdminSummary(businessId).catch(() => ({
    entityCount: 0,
    factCount: 0,
    lastEventAt: null
  }));

  if (!business) notFound();

  // This tenant's economics from the margin engine (same numbers as
  // /admin/costs and /admin/usage). Best effort, the page renders without
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
  // component, never private_key_pem.
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

  // What the onboarding nudge would ask this owner to finish. Same function
  // the /api/admin/nudge route runs, so the reasons shown next to the button
  // are exactly what the email would say.
  const nudgeItems = computeOnboardingNudgeItems({
    subscription,
    websiteMd: config?.website_md,
    didE164: telnyxRoute?.to_e164,
    offers: whiteGloveOffers,
    deals: enterpriseDeals
  });

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
          {/* Deploy moved off the All Clients table, offline boxes are
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
          <div className="grid grid-cols-1 gap-4 mb-4 sm:grid-cols-3">
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
                  <Badge
                    variant={
                      line.source === "actual"
                        ? "success"
                        : line.source === "calibrated"
                          ? "info"
                          : "neutral"
                    }
                  >
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
            Engine: src/lib/admin/margin.ts, renewal-aware revenue, vendor actuals where synced
            (see <Link href="/admin/costs" className="hover:text-signal-teal">Costs</Link>),
            per-unit estimates otherwise. Nothing bills from this card.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Priority support ({formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS)}/month)
        </h2>
        <PrioritySupportPanel
          businessId={businessId}
          status={prioritySupportStatus(business.tier, business.priority_support_until)}
          daysLeft={prioritySupportDaysLeft(business.tier, business.priority_support_until)}
          coverageUntilIso={business.priority_support_until ?? null}
          renewing={Boolean(prioritySupportRow && !prioritySupportRow.cancel_at_period_end)}
          subscribed={Boolean(prioritySupportRow)}
          priceLabel={formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS)}
        />
      </Card>

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
            // Remount on tenant OR mode change so useState re-seeds, a
            // navigation between businesses (or a server refresh after a
            // flip) must never show the previous tenant's mode.
            key={`${businessId}:${business.data_residency_mode ?? "supabase"}`}
            businessId={businessId}
            initialMode={business.data_residency_mode ?? "supabase"}
          />
        </Card>
      )}

      {/* Memory knowledge graph (all tiers, the graph runs fleet-wide) */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Memory knowledge graph
        </h2>
        <MemoryGraphPanel
          // Remount on tenant OR mode change so useState re-seeds.
          key={`${businessId}:${config?.memory_graph_mode ?? "inherit"}`}
          businessId={businessId}
          initialMode={config?.memory_graph_mode ?? "inherit"}
          effectiveMode={kgEffectiveMode}
          entityCount={kgSummary.entityCount}
          factCount={kgSummary.factCount}
          lastEventAt={kgSummary.lastEventAt}
        />
      </Card>

      {/* Privacy / data lifecycle (all tiers, retention + erasure are
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

      {/* Owner-deleted items (soft deletes), view + restore */}
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
                  <dd className="flex flex-wrap items-center gap-2">
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
                    {subscription.billing_paused && <Badge variant="pending">billing paused</Badge>}
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
                  <dt className="text-parchment/40 text-xs">Next charge</dt>
                  <dd className="text-parchment">
                    {subscription.stripe_current_period_end ? (
                      <LocalDateTime
                        iso={subscription.stripe_current_period_end}
                        style="date"
                      />
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
            <div className="space-y-3">
              {/* Let them pay, or provision without charging. Same situation,
                  opposite ends, so they sit together. */}
              <PaymentLinkButton businessId={businessId} />
              <SkipPaymentButton businessId={businessId} />
            </div>
          )}
        </div>
        {/* Comp levers for a live Stripe-billed tenant: pause collection, or
            move the next charge. Hidden for Stripe-less rows (admin-created
            enterprise, skip-payment) because nobody is being charged there. */}
        {subscription &&
          subscription.status === "active" &&
          subscription.stripe_subscription_id && (
            <div className="mt-4 border-t border-parchment/10 pt-4">
              <BillingControlsPanel
                // Remount when the pause state changes so useState re-seeds
                // after a router.refresh().
                key={`${businessId}:${subscription.billing_paused}:${subscription.billing_pause_resumes_at ?? ""}`}
                businessId={businessId}
                initialPaused={subscription.billing_paused}
                initialResumesAt={subscription.billing_pause_resumes_at}
                nextChargeAt={subscription.stripe_current_period_end}
              />
              {/* The partial comp, next to the two all-or-nothing ones. Same
                  visibility rule (active + Stripe-linked), because a row
                  nobody is charged for has no invoice to take a percentage
                  off. */}
              <div className="mt-6 border-t border-parchment/10 pt-4">
                <MembershipDiscountPanel
                  // Remount when the mirrored discount changes, so the form
                  // re-seeds after the router.refresh() a save triggers.
                  key={`${businessId}:${subscription.discount_coupon_id ?? ""}`}
                  businessId={businessId}
                  discount={{
                    discount_coupon_id: subscription.discount_coupon_id,
                    discount_name: subscription.discount_name,
                    discount_percent_off: subscription.discount_percent_off,
                    discount_amount_off_cents: subscription.discount_amount_off_cents,
                    discount_duration: subscription.discount_duration,
                    discount_duration_in_months: subscription.discount_duration_in_months,
                    discount_started_at: subscription.discount_started_at,
                    discount_ends_at: subscription.discount_ends_at
                  }}
                />
              </div>
            </div>
          )}
        {/* Nudge the owner about unfinished onboarding (checkout, website,
            phone number, unpaid offers). The open items are listed here so
            the operator sees what the email would say before sending it. */}
        <div className="mt-4 border-t border-parchment/10 pt-4">
          <NudgeOwnerButton
            // Remount when the open items change so the component drops the
            // post-send list it pins in state. The offer and deal panels
            // router.refresh() this page after a create, and without the
            // remount that pinned list would shadow the newly-open item.
            //
            // The key includes each item's LINK, not just its label, because
            // labels do not identify an item: every open enterprise deal
            // produces the identical "Complete your enterprise plan payment"
            // and two offers can share a name. Revoking one deal and creating
            // another would leave a label-only key unchanged, so the card
            // would keep claiming the reminder covered a pay link that is
            // actually new and was never emailed. The links carry the
            // pay_token, so they change whenever the underlying row does.
            key={`${businessId}:${nudgeItems
              .map((item) => `${item.label}@${item.href ?? ""}`)
              .join("|")}`}
            businessId={businessId}
            openItems={nudgeItems.map((item) => item.label)}
          />
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
          {/* When the paid period ends. The one infrastructure fact that is
              invisible everywhere else on this page: a box can be healthy,
              in posture, and idling at 8% load, and still be eleven days
              from going dark because auto-renew is off. Renewing boxes show
              the same field as prepaid runway, which is what answers "how
              long is this one paid up for" after a term change. */}
          <div>
            <dt className="text-parchment/40 text-xs">Renews / expires</dt>
            <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {boxTerm ? (
                <>
                  <Badge
                    variant={
                      boxTerm.urgent
                        ? "error"
                        : boxTerm.state === "renewing"
                          ? "success"
                          : "pending"
                    }
                  >
                    {boxTerm.state}
                  </Badge>
                  {boxTerm.endsAt ? (
                    <span className="text-parchment font-mono text-xs">
                      <LocalDateTime iso={boxTerm.endsAt} style="date" />
                    </span>
                  ) : (
                    <span className="text-parchment/40 text-xs">date unknown</span>
                  )}
                  {boxTerm.runwayLabel && (
                    <span
                      className={
                        boxTerm.urgent
                          ? "text-spark-orange text-xs"
                          : "text-parchment/40 text-xs"
                      }
                    >
                      {boxTerm.runwayLabel}
                    </span>
                  )}
                  {/* The date is a snapshot, not a live read. Stamp it, so a
                      term the owner changed an hour ago is visibly not in it
                      yet rather than silently contradicting Hostinger. */}
                  {boxSnapshotAt && (
                    <span
                      className={
                        boxSnapshotIsStale
                          ? "text-spark-orange text-[11px]"
                          : "text-parchment/30 text-[11px]"
                      }
                    >
                      (as of <LocalDateTime iso={boxSnapshotAt} />
                      {boxSnapshotIsStale ? ", sync is behind" : ""})
                    </span>
                  )}
                </>
              ) : (
                <span className="text-parchment/40 text-xs">
                  {business.hostinger_vps_id
                    ? "no billing snapshot: run Sync now on /admin/costs"
                    : "–"}
                </span>
              )}
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
          {/* Host load, the input to "is this box too small". Deliberately on
              the same card as the migrate-size control, so the number and the
              action sit together. Peak load is shown PER CORE because that is
              what compares across sizes: 3.0 is idle-ish on 8 cores and badly
              oversubscribed on 2. Absent on a box whose heartbeat predates the
              metrics block, which reads as "not reporting", never as quiet. */}
          <div>
            <dt className="text-parchment/40 text-xs">Host load (last hour)</dt>
            <dd className="text-parchment font-mono text-xs">
              {postureReport?.metrics ? (
                <>
                  {peakLoadPerCore(postureReport.metrics).toFixed(2)} peak/core ·{" "}
                  {postureReport.metrics.memAvailableMinMib} MiB free min
                  {postureReport.metrics.swapUsedMaxMib > 0
                    ? ` · ${postureReport.metrics.swapUsedMaxMib} MiB swap`
                    : ""}{" "}
                  <span className="text-parchment/40">
                    ({postureReport.metrics.samples} samples)
                  </span>
                </>
              ) : (
                <span className="text-parchment/40">not reporting</span>
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
              {/* Active subscription but no box yet, the admin-created
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
            /* Hardware migration is a Hostinger purchase/teardown flow,
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
               down now, the account is cascade-deleted when a new signup
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
          {/* Admin transcript review, the only review surface for widgets
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
          translatorModeEnabled={telnyxSettings?.translator_mode_enabled ?? true}
          translatorAllowed={translatorAllowedForTier(business.tier)}
          voiceName={telnyxSettings?.voice_name ?? null}
          defaultAreaCode={process.env.TELNYX_DEFAULT_AREA_CODE ?? "602"}
          defaultState={process.env.TELNYX_DEFAULT_STATE ?? "AZ"}
        />
      </Card>

      {/* Messaging channel, per-tenant RCS agent + enable switch. Rendered
          for every tier (with a warning when the tier gate would demote
          sends) so an operator can stage the wiring before an upgrade. */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Messaging channel (RCS)
        </h2>
        <RcsChannelPanel
          // Remount on tenant change so useState re-seeds, navigation
          // between businesses must never show the previous tenant's values.
          // Deliberately NOT keyed on the settings values: the panel tracks
          // its own saved baseline, and a value-keyed remount after
          // router.refresh() would wipe the "Saved." confirmation.
          key={businessId}
          businessId={businessId}
          initialAgentId={channelSettings.rcsAgentId}
          initialEnabled={channelSettings.rcsEnabled}
          tierAllows={rcsTierAllowed(business.tier)}
          hasFromNumber={Boolean(
            telnyxSettings?.telnyx_sms_from_e164 || process.env.TELNYX_SMS_FROM_E164
          )}
        />
      </Card>

      {/* Platform contact-form sink, which business (at most one) receives
          public /contact submissions as webhook AiFlow events. Only the HQ
          dogfood tenant should normally hold this. */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Contact form (platform)
        </h2>
        <ContactFormSinkPanel
          // Remount on tenant change so useState re-seeds (see the RCS card
          // note above for why this is keyed on businessId only).
          key={businessId}
          businessId={businessId}
          initialEnabled={contactFormSinkBusinessId === businessId}
          currentSinkBusinessId={contactFormSinkBusinessId}
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

      {/* Admin dashboard mutes, fleet-feed noise control for this tenant */}
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
