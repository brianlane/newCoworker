import { listBusinesses } from "@/lib/db/businesses";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { DeployButton } from "@/components/dashboard/DeployButton";
import { SkipPaymentButton } from "@/components/admin/SkipPaymentButton";

export const dynamic = "force-dynamic";

export default async function ProvisionPage() {
  const businesses = await listBusinesses();
  const subscriptionMap = await listSubscriptionsByBusinessIds(businesses.map((b) => b.id));

  const needsAction = businesses.filter((b) => {
    const sub = subscriptionMap.get(b.id);
    return b.status === "offline" || !sub || sub.status === "pending";
  });

  const provisioned = businesses.filter((b) => {
    const sub = subscriptionMap.get(b.id);
    return b.status !== "offline" && sub && sub.status === "active";
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Provisioning</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Manage client deployment and subscription activation.
        </p>
      </div>

      {/* Needs Action */}
      <div>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Needs Action ({needsAction.length})
        </h2>
        {needsAction.length === 0 ? (
          <Card>
            <p className="text-sm text-parchment/40 text-center py-6">All clients are provisioned.</p>
          </Card>
        ) : (
          <Card padding="sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-parchment/10">
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Business</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Plan</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Payment</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">VPS</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {needsAction.map((b) => {
                  const sub = subscriptionMap.get(b.id);
                  const paymentPending = !sub || sub.status === "pending";
                  return (
                    <tr key={b.id} className="border-b border-parchment/5">
                      <td className="py-3 px-4">
                        <a href={`/admin/${b.id}`} className="text-parchment font-medium hover:text-signal-teal">
                          {b.name}
                        </a>
                        <p className="text-xs text-parchment/30">{b.owner_email}</p>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={b.tier === "standard" ? "online" : "neutral"}>{b.tier}</Badge>
                      </td>
                      <td className="py-3 px-4">
                        {sub ? (
                          <Badge variant={sub.status === "active" ? "success" : "pending"}>{sub.status}</Badge>
                        ) : (
                          <Badge variant="neutral">no subscription</Badge>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusDot status={b.status as "online" | "offline" | "high_load"} showLabel />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          {paymentPending && <SkipPaymentButton businessId={b.id} />}
                          {!paymentPending && b.status === "offline" && (
                            <DeployButton businessId={b.id} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {/* Provisioned */}
      <div>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Provisioned ({provisioned.length})
        </h2>
        {provisioned.length === 0 ? (
          <Card>
            <p className="text-sm text-parchment/40 text-center py-6">No fully provisioned clients yet.</p>
          </Card>
        ) : (
          <Card padding="sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-parchment/10">
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Business</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Plan</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">Status</th>
                  <th className="text-left py-3 px-4 text-parchment/40 font-medium">VPS ID</th>
                </tr>
              </thead>
              <tbody>
                {provisioned.map((b) => (
                  <tr key={b.id} className="border-b border-parchment/5">
                    <td className="py-3 px-4">
                      <a href={`/admin/${b.id}`} className="text-parchment font-medium hover:text-signal-teal">
                        {b.name}
                      </a>
                      <p className="text-xs text-parchment/30">{b.owner_email}</p>
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={b.tier === "standard" ? "online" : "neutral"}>{b.tier}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      <StatusDot status={b.status as "online" | "offline" | "high_load"} showLabel />
                    </td>
                    <td className="py-3 px-4 text-parchment/60 font-mono text-xs">
                      {b.hostinger_vps_id ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
