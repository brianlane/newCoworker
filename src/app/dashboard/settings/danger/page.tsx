import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { DeleteAccountCard } from "@/components/dashboard/DeleteAccountCard";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function DangerZoneSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { isOwner } = await loadSettingsContext();

  return (
    <SettingsPageShell title={t("hubDangerTitle")} blurb={t("dangerPageBlurb")}>
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">{t("dangerSessions")}</h2>
        <p className="text-xs text-parchment/40 mb-4">{t("dangerSessionsBody")}</p>
        <SignOutButton className="text-sm text-spark-orange hover:underline">
          {t("dangerSignOutAll")}
        </SignOutButton>
      </Card>

      {/* Shown during admin view-as too, and live there: the DELETE route
          deletes the impersonated tenant's business and the TENANT owner's
          login (never the operator's own account). Still password-gated on
          the caller's own credentials plus the typed confirm phrase. */}
      {isOwner && <DeleteAccountCard />}
    </SettingsPageShell>
  );
}
