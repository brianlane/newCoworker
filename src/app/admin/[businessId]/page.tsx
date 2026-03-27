import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/db/businesses";
import { getRecentLogs } from "@/lib/db/logs";
import { getBusinessConfig } from "@/lib/db/configs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { SoulEditor } from "@/components/dashboard/SoulEditor";

export const dynamic = "force-dynamic";

export default async function BusinessDetailPage({
  params
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const [business, logs, config] = await Promise.all([
    getBusiness(businessId),
    getRecentLogs(businessId, 20),
    getBusinessConfig(businessId)
  ]);

  if (!business) notFound();

  return (
    <div className="space-y-6 max-w-4xl">
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
            <dt className="text-parchment/40 text-xs">inworld.ai Agent</dt>
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
                  <p className="text-sm text-parchment capitalize">{log.task_type.replace("_", " ")}</p>
                  <p className="text-xs text-parchment/30">
                    {new Date(log.created_at).toLocaleString()}
                  </p>
                </div>
                <Badge
                  variant={
                    log.status === "urgent_alert" || log.status === "error"
                      ? "error"
                      : log.status === "success"
                        ? "success"
                        : "pending"
                  }
                >
                  {log.status.replace("_", " ")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
