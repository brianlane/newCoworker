import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/db/businesses";
import { getRecentLogs } from "@/lib/db/logs";
import { listSystemLogs } from "@/lib/db/system-logs";
import { getProvisioningLogs, type ProvisioningLogPayload } from "@/lib/provisioning/progress";
import { getBusinessConfig } from "@/lib/db/configs";
import { getSubscription } from "@/lib/db/subscriptions";
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
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { AssignDidPanel } from "@/components/admin/AssignDidPanel";
import { KillSwitch } from "@/components/dashboard/KillSwitch";
import { SafeModeToggle } from "@/components/dashboard/SafeModeToggle";
import { getTierLimits } from "@/lib/plans/limits";
import { parseEnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import { EnterpriseLimitsEditor } from "@/components/admin/EnterpriseLimitsEditor";
import { SystemLogViewer } from "@/components/admin/SystemLogViewer";
import { AiFlowRunsCard } from "@/components/admin/AiFlowRunsCard";
import { HardwareSizePanel } from "@/components/admin/HardwareSizePanel";
import { WhiteGloveOffersPanel } from "@/components/admin/WhiteGloveOffersPanel";
import { listWhiteGloveOffers } from "@/lib/db/white-glove-offers";
import { resolveDeployedVpsSize } from "@/lib/vps/size";

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
    whiteGloveOffers
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
    listWhiteGloveOffers(businessId)
  ]);

  if (!business) notFound();

  const systemLogById = new Map(
    [...recentSystemLogs, ...problemSystemLogs].map((row) => [row.id, row])
  );
  const systemLogs = [...systemLogById.values()].sort((a, b) => b.id - a.id);

  const needsPayment = !subscription || subscription.status === "pending";

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between">
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
        <div className="flex flex-col gap-2 items-end">
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
            paid_at: o.paid_at
          }))}
        />
      </Card>

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
        </dl>
        {!business.hostinger_vps_id &&
          subscription?.status === "active" &&
          business.status !== "wiped" && (
            <div className="mb-4">
              {/* Active subscription but no box yet — the admin-created
                  enterprise path lands here (create-client writes an active
                  Stripe-less subscription without provisioning). */}
              <SkipPaymentButton businessId={businessId} label="Provision VPS" />
            </div>
          )}
        {business.hostinger_vps_id && (
          <HardwareSizePanel
            businessId={businessId}
            currentSize={resolveDeployedVpsSize(business.tier, business.vps_size)}
            pinned={business.vps_size != null}
          />
        )}
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
          defaultAreaCode={process.env.TELNYX_DEFAULT_AREA_CODE ?? "602"}
          defaultState={process.env.TELNYX_DEFAULT_STATE ?? "AZ"}
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
