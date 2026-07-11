import { Card } from "@/components/ui/Card";
import { SmsOptOutsCard } from "@/components/dashboard/SmsOptOutsCard";
import { WebchatWidgetSettings } from "@/components/dashboard/WebchatWidgetSettings";
import { webchatAllowedForTier } from "@/lib/webchat/tier-gate";
import { getOrCreateWidgetSettings, getWidgetSettingsForBusiness } from "@/lib/webchat/db";
import { parseWidgetTheme } from "@/lib/webchat/settings-schema";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function ChannelsSettingsPage() {
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
      title="Channels"
      blurb="Phone number, website chat, and how we reach you"
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
        <h2 className="text-sm font-semibold text-parchment mb-4">Phone number</h2>
        <p className="text-xs text-parchment/40">
          Already have a business number your customers know? Transfer it to your AI coworker;
          most ports finish within a week.
        </p>
        <a
          href="/dashboard/settings/number"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Bring your own number →
        </a>
      </Card>

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

      {business && <SmsOptOutsCard businessId={business.id} />}
    </SettingsPageShell>
  );
}
