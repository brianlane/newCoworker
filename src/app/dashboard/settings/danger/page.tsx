import { Card } from "@/components/ui/Card";
import { DeleteAccountCard } from "@/components/dashboard/DeleteAccountCard";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function DangerZoneSettingsPage() {
  const { isOwner } = await loadSettingsContext();

  return (
    <SettingsPageShell title="Danger Zone" blurb="Irreversible actions — read carefully">
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">Sessions</h2>
        <p className="text-xs text-parchment/40 mb-4">
          Signs you out everywhere, including other devices.
        </p>
        <form action="/api/auth/signout" method="POST">
          <button type="submit" className="text-sm text-spark-orange hover:underline">
            Sign out of all sessions
          </button>
        </form>
      </Card>

      {/* Shown during admin view-as too — admins see everything the owner
          sees. Impersonation stays read-only at the API layer: the DELETE
          route refuses view-as, so the card is preview-only for admins. */}
      {isOwner && <DeleteAccountCard />}
    </SettingsPageShell>
  );
}
