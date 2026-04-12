import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listBusinesses } from "@/lib/db/businesses";
import { getRecentLogs } from "@/lib/db/logs";
import {
  getLatestProvisioningStatus,
  shouldMountProvisioningWidget,
  shouldShowProvisioningProgress
} from "@/lib/provisioning/progress";
import { CoworkerProvisioningProgress } from "@/components/dashboard/CoworkerProvisioningProgress";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { KillSwitch } from "@/components/dashboard/KillSwitch";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");
  if (!user.email) redirect("/login?redirectTo=/dashboard");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select()
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  let recentLogs: Awaited<ReturnType<typeof getRecentLogs>> = [];
  let latestProvisioning = null;
  if (business) {
    [recentLogs, latestProvisioning] = await Promise.all([
      getRecentLogs(business.id, 10, undefined, { excludeProvisioning: true }),
      getLatestProvisioningStatus(business.id)
    ]);
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

          <KillSwitch businessId={business.id} initiallyPaused={!!business.is_paused} />

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
            </Card>
            <Card>
              <p className="text-xs text-parchment/40 uppercase tracking-wider mb-2">Business</p>
              <p className="font-semibold text-parchment truncate">{business.name}</p>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card>
            <h2 className="text-sm font-semibold text-parchment/60 uppercase tracking-wider mb-4">
              Recent Activity
            </h2>
            {recentLogs.length === 0 ? (
              <p className="text-sm text-parchment/40">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-parchment/10">
                {recentLogs.map((log) => (
                  <li key={log.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm text-parchment capitalize">{log.task_type.replace("_", " ")}</p>
                      <p className="text-xs text-parchment/40">
                        {new Date(log.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant={
                        log.status === "urgent_alert"
                          ? "error"
                          : log.status === "success"
                            ? "success"
                            : log.status === "error"
                              ? "error"
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
                <p className="text-xs text-parchment/40 mt-1">Workspace, Slack, and API keys</p>
              </Card>
            </a>
            <a href="/dashboard/notifications" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Notifications →</p>
                <p className="text-xs text-parchment/40 mt-1">Configure SMS and email alerts</p>
              </Card>
            </a>
            <a href="/dashboard/settings" className="block">
              <Card className="hover:border-signal-teal/40 transition-colors cursor-pointer">
                <p className="font-semibold text-signal-teal text-sm">Account Settings →</p>
                <p className="text-xs text-parchment/40 mt-1">Billing and account</p>
              </Card>
            </a>
          </div>
        </>
      )}
    </div>
  );
}
