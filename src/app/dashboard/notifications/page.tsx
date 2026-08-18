import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getOrCreateNotificationPreferences,
  mergeNotificationContactsForDisplay
} from "@/lib/db/notification-preferences";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getNotifications } from "@/lib/db/notifications";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { getTranscriptByCallControlId } from "@/lib/db/voice-transcripts";
import {
  applyContactNamesToEventLinks,
  eventLinkE164,
  notificationEventLinks
} from "@/lib/notifications/display";
import { Card } from "@/components/ui/Card";
import { NotificationPreferences } from "@/components/dashboard/NotificationPreferences";
import { NotificationList } from "@/components/dashboard/NotificationList";

export const dynamic = "force-dynamic";

export default async function NotificationsPage(props: {
  searchParams?: Promise<{ logId?: string }>;
}) {
  const t = await getTranslations("dashboard.notificationsPage");
  // Deep link from the activity feeds (owner card and admin view-as click-
  // throughs alike): auto-expand the alert dispatched from this log id.
  const highlightLogId = (await props.searchParams)?.logId;
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

  // Create-on-first-visit runs for an impersonating admin too: the operator
  // should land on the same working page the owner's first visit would build,
  // and be able to save from it. The row is seeded from the TENANT's contacts
  // either way (seedUserEmail/seedAuthPhone above already exclude the admin's
  // own address and phone), so nothing of the operator's leaks into it.
  // Prefs and the recent list are independent, one parallel group (for
  // residency tenants the notifications read is a tunnel round-trip).
  const [prefs, recent, whatsappConnected] = await Promise.all([
    businessId && businessRow
      ? getOrCreateNotificationPreferences(businessId, {
          contactSeeds: {
            userEmail: seedUserEmail,
            authPhone: seedAuthPhone,
            ownerEmail: businessRow.owner_email ?? null,
            businessPhone: businessRow.phone ?? null
          }
        })
      : Promise.resolve(null),
    businessId ? getNotifications(businessId, { limit: 25 }) : Promise.resolve([]),
    // Gates the "WhatsApp instead of SMS" toggle. ACTIVE, not merely
    // present: an inactive connection cannot deliver, and the dispatcher
    // will not honor the preference for one either. A read blip renders the
    // toggle disabled (safe: the dispatcher re-checks at delivery time).
    businessId
      ? getPublicWhatsAppConnection(businessId)
          .then((c) => c?.is_active === true)
          .catch(() => false)
      : Promise.resolve(false)
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

  // Voice alerts stamp Telnyx's `callControlId`, but the call detail route
  // keys on the transcript row UUID (the raw id starts with "v3:" and the
  // literal ":" gets mangled in the routing layer). Resolve the handful on
  // this page to transcript ids so the headline can link to the actual call;
  // a miss just leaves the row pointing at the calls list. Bounded by the
  // page size, and de-duplicated because one dispatch writes a row per
  // channel with the same payload.
  const callControlIds = [
    ...new Set(
      recent
        .map((n) => (n.payload as Record<string, unknown>)?.callControlId)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  ];
  const transcriptIds = new Map<string, string>();
  if (businessId && callControlIds.length > 0) {
    await Promise.all(
      callControlIds.map(async (ccid) => {
        const row = await getTranscriptByCallControlId(businessId, ccid, db).catch(() => null);
        if (row) transcriptIds.set(ccid, row.id);
      })
    );
  }

  const recentWithNames = recent.map((n) => {
    const payload = (n.payload ?? {}) as Record<string, unknown>;
    const events = notificationEventLinks(n);
    const ccid = typeof payload.callControlId === "string" ? payload.callControlId : null;
    const transcriptId = ccid ? transcriptIds.get(ccid) : undefined;
    if (events.length === 0 && !transcriptId) return n;
    return {
      ...n,
      payload: {
        ...payload,
        ...(events.length > 0
          ? { events: applyContactNamesToEventLinks(events, nameMap) }
          : {}),
        ...(transcriptId ? { transcriptId } : {})
      }
    };
  });

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("title")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("subtitle")}</p>
      </div>

      {!businessId || !prefsForDisplay ? (
        <Card>
          <p className="text-parchment/60 text-sm text-center py-6">{t("provisionFirst")}</p>
          <a
            href="/onboard"
            className="block text-center text-sm text-signal-teal hover:underline"
          >
            {t("getStarted")}
          </a>
        </Card>
      ) : (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-parchment mb-4">{t("preferences")}</h2>
            <NotificationPreferences
              businessId={businessId}
              initial={prefsForDisplay}
              whatsappConnected={whatsappConnected}
            />
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-parchment">{t("recent")}</h2>
            </div>
            <NotificationList
              businessId={businessId}
              initial={recentWithNames}
              highlightLogId={highlightLogId}
            />
          </Card>
        </>
      )}
    </div>
  );
}
