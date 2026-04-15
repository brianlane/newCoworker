import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/db/businesses";
import { getRecentLogs } from "@/lib/db/logs";
import { getProvisioningLogs, type ProvisioningLogPayload } from "@/lib/provisioning/progress";
import { getBusinessConfig } from "@/lib/db/configs";
import { getSubscription } from "@/lib/db/subscriptions";
import { formatAdminLabel, getLogBadgeVariant } from "@/lib/admin/dashboard";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { SoulEditor } from "@/components/dashboard/SoulEditor";
import { SkipPaymentButton } from "@/components/admin/SkipPaymentButton";
import { DeleteClientButton } from "@/components/admin/DeleteClientButton";
import { KillSwitch } from "@/components/dashboard/KillSwitch";
import { getTierLimits } from "@/lib/plans/limits";
import { parseEnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import { EnterpriseLimitsEditor } from "@/components/admin/EnterpriseLimitsEditor";

export const dynamic = "force-dynamic";

export default async function BusinessDetailPage({
  params
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const [business, logs, provisioningLogs, config, subscription] = await Promise.all([
    getBusiness(businessId),
    getRecentLogs(businessId, 20, undefined, { excludeProvisioning: true }),
    getProvisioningLogs(businessId, 50),
    getBusinessConfig(businessId),
    getSubscription(businessId)
  ]);

  if (!business) notFound();

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
            status={business.status as "online" | "offline" | "high_load"}
            showLabel
          />
          <Badge variant={business.tier === "standard" ? "online" : "neutral"}>
            {business.tier}
          </Badge>
        </div>
        <DeleteClientButton businessId={businessId} businessName={business.name} />
      </div>

      <KillSwitch
        businessId={businessId}
        initiallyPaused={!!business.is_paused}
        compact
      />

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
              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
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
                  <dd className="text-parchment capitalize">{subscription.billing_period ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-parchment/40 text-xs">Renewal</dt>
                  <dd className="text-parchment">
                    {subscription.renewal_at
                      ? new Date(subscription.renewal_at).toLocaleDateString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-parchment/40 text-xs">Stripe Customer</dt>
                  <dd className="text-parchment font-mono text-xs truncate max-w-[160px]">
                    {subscription.stripe_customer_id ?? "—"}
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
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-parchment/40 text-xs">VPS ID</dt>
            <dd className="text-parchment font-mono">{business.hostinger_vps_id ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Legacy voice agent id</dt>
            <dd className="text-parchment font-mono">{config?.inworld_agent_id ?? "—"}</dd>
          </div>
        </dl>
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
                    <span className="text-xs text-parchment/45 font-mono">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant="neutral" className="text-[10px] uppercase">
                        {src}
                      </Badge>
                      <span className="text-xs text-signal-teal font-medium">{p.percent ?? "—"}%</span>
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
                  <p className="text-xs text-parchment/30">
                    {new Date(log.created_at).toLocaleString()}
                  </p>
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
