import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getAllRecentActivity,
  activityWindowDays,
  ACTIVITY_FEED_MAX,
  type ActivityItem
} from "@/lib/db/activity";
import { Card } from "@/components/ui/Card";
import { ActivityList } from "@/components/dashboard/ActivityList";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/activity");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier")
    .eq("owner_email", ownerEmail)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;
  const tier = businesses?.[0]?.tier ?? null;
  const windowDays = activityWindowDays(tier);

  let items: ActivityItem[] = [];
  if (businessId) {
    items = await getAllRecentActivity(businessId, ACTIVITY_FEED_MAX, db, tier).catch(() => []);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">All activity</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Calls, texts, emails, dashboard chat, AiFlow runs, new customers, and alerts from the
            last {windowDays} days.
            {tier === "starter" && " Upgrade to Standard for 90 days of history."}
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-signal-teal hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">No business found.</p>
        </Card>
      ) : (
        <ActivityList items={items} />
      )}
    </div>
  );
}
