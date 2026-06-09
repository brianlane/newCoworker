import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getOrCreateNotificationPreferences,
  mergeNotificationContactsForDisplay
} from "@/lib/db/notification-preferences";
import { getNotifications } from "@/lib/db/notifications";
import { Card } from "@/components/ui/Card";
import { NotificationPreferences } from "@/components/dashboard/NotificationPreferences";
import { NotificationList } from "@/components/dashboard/NotificationList";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/notifications");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, owner_email, phone")
    .eq("owner_email", user.email)
    .limit(1);

  const businessRow = businesses?.[0] ?? null;
  const businessId = businessRow?.id ?? null;

  const prefs =
    businessId && businessRow
      ? await getOrCreateNotificationPreferences(businessId, {
          contactSeeds: {
            userEmail: user.email,
            authPhone: user.phone ?? null,
            ownerEmail: businessRow.owner_email ?? null,
            businessPhone: businessRow.phone ?? null
          }
        })
      : null;
  // Display-only autofill: prefill the alert phone/email inputs from the
  // owner's account + business contact info when the stored prefs are still
  // empty. The DB row is untouched until the owner clicks Save.
  const prefsForDisplay =
    prefs && businessRow
      ? {
          ...prefs,
          ...mergeNotificationContactsForDisplay(prefs, {
            userEmail: user.email,
            authPhone: user.phone ?? null,
            ownerEmail: businessRow.owner_email ?? null,
            businessPhone: businessRow.phone ?? null
          })
        }
      : prefs;

  const recent = businessId ? await getNotifications(businessId, { limit: 25 }) : [];

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Notifications</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Choose how we reach you and review recent delivery history
        </p>
      </div>

      {!businessId || !prefsForDisplay ? (
        <Card>
          <p className="text-parchment/60 text-sm text-center py-6">
            Provision your coworker to configure notification preferences.
          </p>
          <a
            href="/onboard"
            className="block text-center text-sm text-signal-teal hover:underline"
          >
            Get started →
          </a>
        </Card>
      ) : (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-parchment mb-4">Preferences</h2>
            <NotificationPreferences businessId={businessId} initial={prefsForDisplay} />
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-parchment">Recent notifications</h2>
            </div>
            <NotificationList businessId={businessId} initial={recent} />
          </Card>
        </>
      )}
    </div>
  );
}
