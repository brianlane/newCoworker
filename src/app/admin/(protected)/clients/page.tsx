import { listBusinesses } from "@/lib/db/businesses";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { DeployButton } from "@/components/dashboard/DeployButton";
import { CreateClientModal } from "@/components/admin/CreateClientModal";

export const dynamic = "force-dynamic";

export default async function AdminClientsPage() {
  const businesses = await listBusinesses();
  const subscriptionMap = await listSubscriptionsByBusinessIds(businesses.map((b) => b.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Admin Overview</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {businesses.length} active client{businesses.length !== 1 ? "s" : ""}
          </p>
        </div>
        <CreateClientModal />
      </div>

      {businesses.length === 0 ? (
        <Card>
          <p className="text-parchment/50 text-sm text-center py-8">
            No clients yet. Onboard the first one!
          </p>
        </Card>
      ) : (
        <Card padding="sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-parchment/10">
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Business</th>
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Owner</th>
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Plan</th>
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Payment</th>
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Status</th>
                <th className="text-left py-3 px-4 text-parchment/40 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id} className="border-b border-parchment/5 hover:bg-parchment/3">
                  <td className="py-3 px-4">
                    <a href={`/admin/${b.id}`} className="text-parchment font-medium hover:text-signal-teal">
                      {b.name}
                    </a>
                    <p className="text-xs text-parchment/30 mt-0.5">
                      {new Date(b.created_at).toLocaleDateString()}
                    </p>
                  </td>
                  <td className="py-3 px-4 text-parchment/70">{b.owner_email}</td>
                  <td className="py-3 px-4">
                    <Badge variant={b.tier === "standard" ? "online" : "neutral"}>
                      {b.tier}
                    </Badge>
                  </td>
                  <td className="py-3 px-4">
                    {(() => {
                      const sub = subscriptionMap.get(b.id);
                      if (!sub) return <Badge variant="neutral">no subscription</Badge>;
                      return (
                        <Badge
                          variant={
                            sub.status === "active"
                              ? "success"
                              : sub.status === "past_due"
                                ? "error"
                                : "pending"
                          }
                        >
                          {sub.status}
                        </Badge>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-4">
                    <StatusDot
                      status={b.status as "online" | "offline" | "high_load"}
                      showLabel
                    />
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <a
                        href={`/admin/${b.id}`}
                        className="text-xs text-signal-teal hover:underline"
                      >
                        Details
                      </a>
                      {b.status === "offline" && (
                        <DeployButton businessId={b.id} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
