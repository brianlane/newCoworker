import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getOrCreateNotificationPreferences } from "@/lib/db/notification-preferences";
import { getNotifications } from "@/lib/db/notifications";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { NotificationPreferences } from "@/components/dashboard/NotificationPreferences";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/notifications");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .limit(1);

  const businessId = businesses?.[0]?.id ?? null;

  const prefs = businessId ? await getOrCreateNotificationPreferences(businessId) : null;
  const recent = businessId ? await getNotifications(businessId, 25) : [];

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Notifications</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Choose how we reach you and review recent delivery history
        </p>
      </div>

      {!businessId || !prefs ? (
        <Card>
          <p className="text-parchment/60 text-sm text-center py-6">
            Provision your coworker to configure notification preferences.
          </p>
          <a
            href="/onboard"
            className="block text-center text-sm text-signal-teal hover:underline"
          >
            Get started →
          </a>
        </Card>
      ) : (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-parchment mb-4">Preferences</h2>
            <NotificationPreferences businessId={businessId} initial={prefs} />
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-parchment mb-4">Recent notifications</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-parchment/40">No notifications yet.</p>
            ) : (
              <ul className="divide-y divide-parchment/10">
                {recent.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div>
                      <p className="text-sm text-parchment capitalize">{n.delivery_channel}</p>
                      <p className="text-xs text-parchment/40">
                        {new Date(n.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant={
                        n.status === "sent"
                          ? "success"
                          : n.status === "failed"
                            ? "error"
                            : "pending"
                      }
                    >
                      {n.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
