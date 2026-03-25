import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier")
    .eq("owner_email", user.email)
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Account Settings</h1>
        <p className="text-sm text-parchment/50 mt-1">Billing, notifications, and preferences</p>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Account</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-parchment/50">Email</dt>
            <dd className="text-parchment">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-parchment/50">Plan</dt>
            <dd>
              <Badge variant={business?.tier === "standard" ? "online" : "neutral"}>
                {business?.tier ?? "—"}
              </Badge>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-parchment/50">Subscription status</dt>
            <dd>
              <Badge variant={subscription?.status === "active" ? "success" : "pending"}>
                {subscription?.status ?? "—"}
              </Badge>
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Notifications</h2>
        <p className="text-xs text-parchment/40">
          SMS and email alerts are automatically sent when your coworker flags an urgent event.
          Configure your phone number and email in your account settings.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-parchment/60">
          <li>✓ Urgent event SMS alerts</li>
          <li>✓ Daily email digest</li>
          <li>✓ Provisioning confirmations</li>
        </ul>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">Danger Zone</h2>
        <p className="text-xs text-parchment/40 mb-4">
          These actions are irreversible. Contact support before proceeding.
        </p>
        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="text-sm text-spark-orange hover:underline"
          >
            Sign out of all sessions
          </button>
        </form>
      </Card>
    </div>
  );
}
