import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAllRecentActivity, ACTIVITY_FEED_MAX, type ActivityItem } from "@/lib/db/activity";
import { Card } from "@/components/ui/Card";
import { ActivityList } from "@/components/dashboard/ActivityList";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/activity");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  let items: ActivityItem[] = [];
  if (businessId) {
    items = await getAllRecentActivity(businessId, ACTIVITY_FEED_MAX, db).catch(() => []);
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">All activity</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Calls, texts, dashboard chat, AiFlow runs, new customers, and alerts from the last 30
            days.
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
