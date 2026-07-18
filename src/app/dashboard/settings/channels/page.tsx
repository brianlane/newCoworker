import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { SmsOptOutsCard } from "@/components/dashboard/SmsOptOutsCard";
import { WebchatWidgetSettings } from "@/components/dashboard/WebchatWidgetSettings";
import { webchatAllowedForTier } from "@/lib/webchat/tier-gate";
import { getOrCreateWidgetSettings, getWidgetSettingsForBusiness } from "@/lib/webchat/db";
import { parseWidgetTheme } from "@/lib/webchat/settings-schema";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function ChannelsSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { business, viewAs } = await loadSettingsContext();

  // Website chat widget (Standard+). Mint-on-first-read only outside
  // view-as — view-as stays read-only (same rationale as the mailbox card).
  const webchatTierAllowed = webchatAllowedForTier(business?.tier);
  const widgetRow = business
    ? viewAs || !webchatTierAllowed
      ? await getWidgetSettingsForBusiness(business.id)
      : await getOrCreateWidgetSettings(business.id)
    : null;

  return (
    <SettingsPageShell
      title={t("hubChannelsTitle")}
      blurb={t("channelsPageBlurb")}
    >
      {business && (
        <WebchatWidgetSettings
          businessId={business.id}
          tierAllowed={webchatTierAllowed}
          initialSettings={
            widgetRow
              ? {
                  enabled: widgetRow.enabled,
                  publicKey: widgetRow.public_key,
                  allowedOrigins: widgetRow.allowed_origins ?? [],
                  requireContactForm: widgetRow.require_contact_form,
                  theme: parseWidgetTheme(widgetRow.theme)
                }
              : null
          }
        />
      )}

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">{t("channelsPhoneTitle")}</h2>
        <p className="text-xs text-parchment/40">{t("channelsPhoneBody")}</p>
        <a
          href="/dashboard/settings/number"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          {t("channelsPhoneCta")}
        </a>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">{t("channelsNotificationsTitle")}</h2>
        <p className="text-xs text-parchment/40">{t("channelsNotificationsBody")}</p>
        <a
          href="/dashboard/notifications"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          {t("channelsNotificationsCta")}
        </a>
      </Card>

      {business && <SmsOptOutsCard businessId={business.id} />}
    </SettingsPageShell>
  );
}
