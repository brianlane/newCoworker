import { listBusinesses } from "@/lib/db/businesses";
import { getTranslations } from "next-intl/server";
import { listAllBusinessMembers } from "@/lib/db/business-members";
import {
  buildUserEngagementRows,
  listPlatformAuthUsers,
  quietOwnerBusinessIds
} from "@/lib/admin/user-engagement";
import { Card } from "@/components/ui/Card";
import { UserEngagementTable } from "@/components/admin/UserEngagementTable";
import { EngagementKpis } from "@/components/admin/EngagementKpis";

export const dynamic = "force-dynamic";

export default async function AdminEngagementPage() {
  const t = await getTranslations("admin.pages");
  const [{ users, clipped }, businesses, members] = await Promise.all([
    listPlatformAuthUsers(),
    listBusinesses(),
    listAllBusinessMembers()
  ]);

  const rows = buildUserEngagementRows({ users, businesses, members });
  // The churn-risk KPI counts quiet OWNERS (per business) — the same set
  // that gets the churn-risk badge on /admin/clients, so the two surfaces
  // always agree. On a clipped (partial) auth scan the clients page hides
  // its badges, so this KPI goes unknown too rather than overstating risk
  // for owners the scan never reached.
  const quietOwnerCount = clipped ? null : quietOwnerBusinessIds(rows).size;
  const quietRowCount = rows.filter((r) => r.segment === "quiet").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("engagementTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("engagementSubtitle")}</p>
      </div>

      {clipped && (
        <Card className="border-spark-orange/40">
          <p className="text-sm text-spark-orange">
            Auth directory scan hit its page cap — counts and segments below cover only the
            users collected so far, and uncollected users may show as never signed in.
          </p>
        </Card>
      )}

      {/* KPI row (BizBlasts' DAU analytics panel) — client-computed so
          "Active Today" is the viewer's calendar day. */}
      <EngagementKpis
        users={users}
        quietOwnerCount={quietOwnerCount}
        quietRowCount={quietRowCount}
      />

      <Card padding="sm">
        <UserEngagementTable rows={rows} />
      </Card>
    </div>
  );
}
