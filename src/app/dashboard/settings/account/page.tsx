import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { getLocale, getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { getSubscription } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { effectiveSmsMonthlyCap } from "@/lib/plans/limits";
import { AccountCredentialsForms } from "@/components/dashboard/AccountCredentialsForms";
import { PasskeysCard } from "@/components/dashboard/PasskeysCard";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { OwnLoginNotice } from "@/components/dashboard/OwnLoginNotice";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const locale = (await getLocale()) as AppLocale;
  const { user, business, viewAs, accountEmail } = await loadSettingsContext();
  // Under view-as the account this page administers is the TENANT's, and the
  // user-scoped APIs already retarget there. `selfOwned` (the admin on their
  // own HQ tenant) is not impersonation: the account IS theirs.
  const impersonating = viewAs !== null && !viewAs.selfOwned;
  const shownEmail = accountEmail ?? user.email ?? "";
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
        <OwnLoginNotice show={impersonating}>{t("viewAsLanguageNotice")}</OwnLoginNotice>
        <LanguageSwitcher persist />
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">{t("accountTitle")}</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-parchment/50">{t("emailLabel")}</dt>
            <dd className="text-parchment">{shownEmail}</dd>
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
                  business.tier === "enterprise" ? business.enterprise_limits : undefined,
                  locale
                )}
                <br />
                {smsMonthlyLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined,
                  locale,
                  // Effective cap (MX clamp included) so this page can never
                  // show an allowance Postgres will not honor; dashboard and
                  // billing already pass the same override.
                  effectiveSmsMonthlyCap(
                    business.tier as PlanTier,
                    business.tier === "enterprise" ? business.enterprise_limits : undefined,
                    { phone: business.phone, timezone: business.timezone }
                  )
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
              {t("manageBilling")}
            </button>
          </form>
        )}
      </Card>

      <AccountCredentialsForms
        email={shownEmail}
        callerEmail={user.email ?? ""}
        impersonating={impersonating}
        impersonationNotice={t("viewAsAccountNotice")}
        ownLoginNotice={t("viewAsOwnLoginNotice")}
      />

      {/* Session-scoped, so it stays the OPERATOR's passkeys under view-as and
          says so. There is no API to enroll a passkey on someone else's
          device. */}
      <PasskeysCard ownLoginNotice={impersonating ? t("viewAsOwnPasskeysNotice") : undefined} />
    </SettingsPageShell>
  );
}
