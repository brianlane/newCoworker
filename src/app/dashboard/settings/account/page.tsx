import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { getTranslations } from "next-intl/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { AccountCredentialsForms } from "@/components/dashboard/AccountCredentialsForms";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { user, business } = await loadSettingsContext();
  const subscription = business ? await getSubscription(business.id) : null;
  const nextBillingAt =
    subscription?.status === "active" && !subscription.cancel_at_period_end
      ? await resolveActiveRenewalDate(subscription)
      : null;

  return (
    <SettingsPageShell title={t("accountTitle")} blurb={t("accountBlurb")}>
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">{t("languageTitle")}</h2>
        <p className="text-xs text-parchment/40 mb-4">{t("languageBlurb")}</p>
        <LanguageSwitcher persist />
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">{t("accountTitle")}</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-parchment/50">{t("emailLabel")}</dt>
            <dd className="text-parchment">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-parchment/50">{t("planLabel")}</dt>
            <dd>
              <Badge variant={business?.tier === "standard" ? "online" : "neutral"}>
                {business?.tier ?? "–"}
              </Badge>
            </dd>
          </div>
          {business?.tier && (
            <div className="pt-2 border-t border-parchment/10">
              <dt className="text-parchment/50 text-xs mb-1">{t("includedUsage")}</dt>
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
            <dt className="text-parchment/50">{t("subscriptionStatus")}</dt>
            <dd>
              <Badge variant={subscription?.status === "active" ? "success" : "pending"}>
                {subscription?.status ?? "–"}
              </Badge>
            </dd>
          </div>
          {nextBillingAt && (
            <div className="flex justify-between">
              <dt className="text-parchment/50">{t("nextBilling")}</dt>
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
          {t("voiceTopUps")}
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
