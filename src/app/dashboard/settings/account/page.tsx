import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { getSubscription } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { AccountCredentialsForms } from "@/components/dashboard/AccountCredentialsForms";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const { user, business } = await loadSettingsContext();
  const subscription = business ? await getSubscription(business.id) : null;
  // Same rolling next-charge date the Billing page shows (Stripe's
  // current_period_end, cached and webhook-advanced; see resolveActiveRenewalDate).
  const nextBillingAt =
    subscription?.status === "active" && !subscription.cancel_at_period_end
      ? await resolveActiveRenewalDate(subscription)
      : null;

  return (
    <SettingsPageShell title="Account" blurb="Plan, billing, login email, and password">
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
                {business?.tier ?? "–"}
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
                {subscription?.status ?? "–"}
              </Badge>
            </dd>
          </div>
          {nextBillingAt && (
            <div className="flex justify-between">
              <dt className="text-parchment/50">Next billing date</dt>
              <dd className="text-parchment font-mono">
                <LocalDateTime iso={nextBillingAt} style="date" />
              </dd>
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
            <button type="submit" className="text-sm text-claw-green hover:underline">
              Manage billing and payment methods
            </button>
          </form>
        )}
      </Card>

      <AccountCredentialsForms email={user.email ?? ""} />
    </SettingsPageShell>
  );
}
