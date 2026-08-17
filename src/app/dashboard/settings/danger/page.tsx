import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { DeleteAccountCard } from "@/components/dashboard/DeleteAccountCard";
import { OwnLoginNotice } from "@/components/dashboard/OwnLoginNotice";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function DangerZoneSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { isOwner, viewAs } = await loadSettingsContext();
  // `selfOwned` (the admin on their own HQ tenant) is not impersonation.
  const impersonating = viewAs !== null && !viewAs.selfOwned;

  return (
    <SettingsPageShell title={t("hubDangerTitle")} blurb={t("dangerPageBlurb")}>
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">{t("dangerSessions")}</h2>
        {/* Session-scoped like the password and passkey cards: /api/auth/signout
            revokes the CALLER's cookies (and clears the view-as cookie), so
            under impersonation this ends the operator's session, not the
            tenant's. Labeled rather than hidden: an operator reading "sign out
            all sessions" on a page showing a customer would reasonably expect
            it to sign the customer out. */}
        <OwnLoginNotice show={impersonating}>{t("viewAsOwnSessionsNotice")}</OwnLoginNotice>
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
