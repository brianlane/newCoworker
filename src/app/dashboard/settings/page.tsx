import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { AccountSettingsForms } from "@/components/dashboard/AccountSettingsForms";
import { CoworkerToolsManager } from "@/components/dashboard/CoworkerToolsManager";
import { resolveAgentTools } from "@/lib/db/agent-tool-settings";

export const dynamic = "force-dynamic";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return iso;
  }
}

export default async function SettingsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, tier, enterprise_limits")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;
  const agents = business ? await resolveAgentTools(business.id) : null;
  // Same rolling next-charge date the Billing page shows (Stripe's
  // current_period_end, cached and webhook-advanced; see resolveActiveRenewalDate).
  const nextBillingAt =
    subscription?.status === "active" && !subscription.cancel_at_period_end
      ? formatDate(await resolveActiveRenewalDate(subscription))
      : null;

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
          {business?.tier && (
            <div className="pt-2 border-t border-parchment/10">
              <dt className="text-parchment/50 text-xs mb-1">Included usage</dt>
              <dd className="text-xs text-parchment/60 leading-relaxed">
                {voiceMinutesLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
                <br />
                {smsMonthlyLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-parchment/50">Subscription status</dt>
            <dd>
              <Badge variant={subscription?.status === "active" ? "success" : "pending"}>
                {subscription?.status ?? "—"}
              </Badge>
            </dd>
          </div>
          {nextBillingAt && (
            <div className="flex justify-between">
              <dt className="text-parchment/50">Next billing date</dt>
              <dd className="text-parchment font-mono">{nextBillingAt}</dd>
            </div>
          )}
        </dl>
        <a
          href="/dashboard/billing"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Voice minutes and top-ups →
        </a>
        {subscription?.stripe_customer_id && (
          <form action="/api/billing/portal" method="POST" className="mt-2">
            <button
              type="submit"
              className="text-sm text-claw-green hover:underline"
            >
              Manage billing and payment methods
            </button>
          </form>
        )}
      </Card>

      <AccountSettingsForms businessName={business?.name ?? ""} email={user.email} />

      {business && agents && (
        <CoworkerToolsManager businessId={business.id} initialAgents={agents} />
      )}

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Notifications</h2>
        <p className="text-xs text-parchment/40">
          Choose how your coworker reaches you when something urgent happens, and review
          recent delivery history.
        </p>
        <a
          href="/dashboard/notifications"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Manage notifications →
        </a>
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
