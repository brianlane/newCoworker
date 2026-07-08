import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  defaultNotificationPreferencesRow,
  getNotificationPreferences,
  getOrCreateNotificationPreferences,
  mergeNotificationContactsForDisplay
} from "@/lib/db/notification-preferences";
import { getNotifications } from "@/lib/db/notifications";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import {
  applyContactNamesToEventLinks,
  eventLinkE164,
  notificationEventLinks
} from "@/lib/notifications/display";
import { Card } from "@/components/ui/Card";
import { NotificationPreferences } from "@/components/dashboard/NotificationPreferences";
import { NotificationList } from "@/components/dashboard/NotificationList";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/notifications");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email. While
  // impersonating, the signed-in admin's own email/phone must NOT leak into
  // the tenant's contact seeds or the display autofill below.
  const viewAsCtx = await resolveViewAsContext(user);
  const ownerEmail = viewAsCtx.ownerEmail ?? user.email;
  const seedUserEmail = viewAsCtx.viewAs ? ownerEmail : user.email;
  const seedAuthPhone = viewAsCtx.viewAs ? null : (user.phone ?? null);

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, owner_email, phone")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const businessRow = businesses?.[0] ?? null;
  const businessId = businessRow?.id ?? null;

  // View-as stays strictly read-only: it must not create the tenant's default
  // preference row as a page-load side effect. When the tenant has never
  // visited this page (no row yet), render the same in-memory defaults the
  // owner's first visit would insert, so the admin still previews the real
  // page instead of a bogus "provision your coworker" empty state. Real
  // owners keep the create-on-first-visit behavior.
  // Prefs and the recent list are independent — one parallel group (for
  // residency tenants the notifications read is a tunnel round-trip).
  const [prefs, recent] = await Promise.all([
    businessId && businessRow
      ? viewAsCtx.viewAs
        ? getNotificationPreferences(businessId).then(
            (row) => row ?? defaultNotificationPreferencesRow(businessId)
          )
        : getOrCreateNotificationPreferences(businessId, {
            contactSeeds: {
              userEmail: seedUserEmail,
              authPhone: seedAuthPhone,
              ownerEmail: businessRow.owner_email ?? null,
              businessPhone: businessRow.phone ?? null
            }
          })
      : Promise.resolve(null),
    businessId ? getNotifications(businessId, { limit: 25 }) : Promise.resolve([])
  ]);
  // Display-only autofill: prefill the alert phone/email inputs from the
  // owner's account + business contact info when the stored prefs are still
  // empty. The DB row is untouched until the owner clicks Save.
  const prefsForDisplay =
    prefs && businessRow
      ? {
          ...prefs,
          ...mergeNotificationContactsForDisplay(prefs, {
            userEmail: seedUserEmail,
            authPhone: seedAuthPhone,
            ownerEmail: businessRow.owner_email ?? null,
            businessPhone: businessRow.phone ?? null
          })
        }
      : prefs;

  // Swap raw phone numbers in the stored digest event labels for known contact
  // names, using the same resolver the dashboard's Recent Activity uses. The
  // digest is built server-side (Edge) where the names aren't available, so we
  // resolve and substitute at render time; this also retroactively names older
  // notifications. A resolver failure leaves the raw numbers untouched.
  const eventE164s = recent
    .flatMap((n) => notificationEventLinks(n))
    .map((ev) => eventLinkE164(ev.href))
    .filter((x): x is string => Boolean(x));
  const contactNames =
    businessId && eventE164s.length > 0
      ? await resolveContactNames(businessId, eventE164s, db).catch(
          () => new Map<string, ContactName>()
        )
      : new Map<string, ContactName>();
  const nameMap = new Map<string, string>();
  for (const [e164, c] of contactNames) nameMap.set(e164, c.name);
  const recentWithNames = recent.map((n) => {
    const events = notificationEventLinks(n);
    if (events.length === 0) return n;
    return {
      ...n,
      payload: { ...(n.payload ?? {}), events: applyContactNamesToEventLinks(events, nameMap) }
    };
  });

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
            <NotificationList businessId={businessId} initial={recentWithNames} />
          </Card>
        </>
      )}
    </div>
  );
}
