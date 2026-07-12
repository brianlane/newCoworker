import { listBusinesses } from "@/lib/db/businesses";
import { listAllBusinessMembers } from "@/lib/db/business-members";
import {
  buildUserEngagementRows,
  listPlatformAuthUsers,
  summarizeUserEngagement
} from "@/lib/admin/user-engagement";
import { Card } from "@/components/ui/Card";
import { UserEngagementTable } from "@/components/admin/UserEngagementTable";

export const dynamic = "force-dynamic";

export default async function AdminEngagementPage() {
  const [users, businesses, members] = await Promise.all([
    listPlatformAuthUsers(),
    listBusinesses(),
    listAllBusinessMembers()
  ]);

  const summary = summarizeUserEngagement(users);
  const rows = buildUserEngagementRows({ users, businesses, members });
  const quietCount = rows.filter((r) => r.segment === "quiet").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Engagement</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Sign-in activity across every owner and team member.
        </p>
      </div>

      {/* KPI row (BizBlasts' DAU analytics panel) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Active Today</p>
          <p className="text-3xl font-bold text-parchment">{summary.activeToday}</p>
          <p className="text-xs text-parchment/30 mt-1">
            {summary.dailyEngagementRatePct}% of {summary.totalUsers} users
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Active: 7 Days
          </p>
          <p className="text-3xl font-bold text-claw-green">{summary.active7d}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
            Active: 30 Days
          </p>
          <p className="text-3xl font-bold text-signal-teal">{summary.active30d}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Quiet (90d+)</p>
          <p
            className={`text-3xl font-bold ${
              quietCount > 0 ? "text-spark-orange" : "text-parchment"
            }`}
          >
            {quietCount}
          </p>
          <p className="text-xs text-parchment/30 mt-1">churn-risk rows</p>
        </Card>
      </div>

      <Card padding="sm">
        <UserEngagementTable rows={rows} />
      </Card>
    </div>
  );
}
