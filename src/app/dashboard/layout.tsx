import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { CompanionLauncher } from "@/components/dashboard/companion/CompanionLauncher";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isCanceledInGrace } from "@/lib/db/subscriptions";
import type { CancelReason, SubscriptionRow } from "@/lib/db/subscriptions";
import { GraceBanner } from "@/components/billing/GraceBanner";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";
import { bindBusinessMemberUser } from "@/lib/db/business-members";
import {
  resolveActiveBusinessContext,
  type AccessibleBusiness
} from "@/lib/dashboard/active-business";
import { getSidebarLayout } from "@/lib/dashboard/sidebar-prefs";
import { filterSidebarItemsForBusiness } from "@/lib/dashboard/sidebar-items";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { logger } from "@/lib/logger";
import { can } from "@/lib/authz/policy";
import { effectiveBranding, type Branding } from "@/lib/plans/branding";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { ViewAsBanner } from "@/components/admin/ViewAsBanner";
import { latestAcceptanceFor, needsAcceptance } from "@/lib/legal/acceptance";
import { TermsAcceptanceGate } from "@/components/legal/TermsAcceptanceGate";
import { SectionMessages } from "@/components/i18n/SectionMessages";
import { HipaaIdleLogout } from "@/components/dashboard/HipaaIdleLogout";
import { PushRegistrar } from "@/components/push/PushRegistrar";
import { PushOptInBanner } from "@/components/push/PushOptInBanner";

// `cover` lets the h-dvh shell paint edge-to-edge under the notch / home
// indicator; the shell's safe-area padding (globals.css) keeps content clear.
// Scoped to this segment so marketing/auth/onboarding routes keep the default
// (safe) viewport and never render under the notch.
export const viewport: Viewport = {
  viewportFit: "cover"
};

type EmbeddedSubscriptionRow = Pick<
  SubscriptionRow,
  "status" | "grace_ends_at" | "wiped_at" | "cancel_reason" | "created_at"
>;

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");

  // Admin view-as: when active, every owner_email lookup below (and in the
  // pages) resolves against the impersonated tenant instead of the admin.
  const { ownerEmail, viewAs } = await resolveViewAsContext(user);

  // Orphan view-as cookie (impersonated business deleted, or a garbled
  // value): the proxy only gates the admin→/dashboard redirect on the
  // cookie's PRESENCE, so without this the admin would land here
  // unimpersonated, no banner, no exit. Send them back to the admin panel;
  // the leftover cookie is inert (every consumer keys off this resolution)
  // and is overwritten by the next "View as tenant" or expires on its own.
  if (user.isAdmin && !viewAs) redirect("/admin/dashboard");

  // Per-user nav customization (order + visibility). Keyed to the SIGNED-IN
  // user (not the tenant), so an admin in view-as sees their own layout.
  // Degrades to the default catalog on any read hiccup inside the helper.
  // Kicked off FIRST so it overlaps every tenant-scoped read below, it only
  // depends on the user id, never on the resolved business.
  const sidebarLayoutPromise = getSidebarLayout(user.userId);

  // Clickwrap gate read: does this user have an acceptance row for the
  // CURRENT legal versions (src/lib/legal/versions.ts)? Kicked off beside
  // the sidebar read since it only depends on a user id.
  //
  // NEVER raised under view-as. Consent is the one thing an operator cannot
  // do for a tenant (/api/legal/accept refuses an impersonating admin,
  // deliberately), so surfacing the tenant's outstanding clickwrap here would
  // strand the operator behind a modal they are not allowed to satisfy. The
  // tenant clears it themselves on their next sign-in.
  const acceptancePromise: Promise<boolean> = viewAs
    ? Promise.resolve(false)
    : latestAcceptanceFor(user.userId).then(needsAcceptance);

  let grace:
    | { graceEndsAt: string; reason: Parameters<typeof GraceBanner>[0]["reason"] }
    | null = null;
  let businessId: string | null = null;
  let accessible: AccessibleBusiness[] = [];
  let brand: Branding | null = null;
  let hipaaMode = false;
  let metaConnected = false;
  let whatsappConnected = false;
  if (ownerEmail) {
    // Single-round-trip grace lookup. Next.js layouts re-execute on every
    // navigation under `/dashboard`, so we previously paid 2 sequential
    // DB round-trips per page render (businesses lookup + subscriptions
    // lookup) for every signed-in user, even on pages unrelated to
    // billing (soul editor, voice usage, etc.). Fold both lookups into
    // one PostgREST query that selects the most recent business by
    // owner_email and embeds the subscriptions for that business in the
    // same response. We then pick the most recent subscription on the
    // server before deciding whether to render `<GraceBanner />`.
    const db = await createSupabaseServiceClient();
    // If the owner just confirmed an account-email change (possibly on another
    // device, or via a plain password sign-in that never hit /api/auth/callback),
    // mirror the new email onto their business BEFORE the owner_email lookup
    // below, otherwise that lookup would miss and the dashboard would render as
    // if they had no business. No-op (one cheap PK read) when nothing is
    // pending. Skipped during view-as: the admin's pending email change (if
    // any) must not be reconciled onto the impersonated tenant's business.
    if (!viewAs && user.email) {
      // First-login binding for team invites: flip INVITED business_members
      // rows addressed to this email to active with the auth user id stamped.
      // Same layout-render-write precedent as reconcilePendingEmailChange,
      // a cheap indexed no-op for everyone without a pending invite. Best-
      // effort: a hiccup here must never take down the dashboard. The two
      // writes touch different tables and don't depend on each other, so
      // they run in parallel; both still complete BEFORE the owner_email
      // lookup below, which is the ordering that actually matters.
      await Promise.all([
        reconcilePendingEmailChange(user.userId, user.email, db),
        bindBusinessMemberUser(user.userId, user.email, db).catch(() => {
          // Next render retries; membership stays 'invited' meanwhile.
        })
      ]);
    }
    // Multi-business (agency) resolution: owned businesses ∪ memberships,
    // with the switcher cookie picking the active one (validated against the
    // accessible set on every read). Admin view-as resolves to its pinned
    // business inside the helper, unchanged.
    const ctx = await resolveActiveBusinessContext(user);
    businessId = ctx.businessId;
    accessible = ctx.accessible;
    if (businessId) {
      // The four reads below are independent of each other (branding row,
      // newest subscription, Meta connection, WhatsApp connection), they
      // used to run as four sequential round-trips on EVERY dashboard
      // navigation; one Promise.all collapses them to the slowest single
      // read. The grace lookup is gated up front: its CTA is
      // /api/billing/reactivate (manage_billing, owner-only), don't dangle
      // it in front of managers/staff whose click would just 403. The
      // connection reads degrade to "not connected" on error, a read
      // hiccup hides the Messenger/WhatsApp nav rather than breaking it.
      const graceEligible = !!ctx.role && can(ctx.role, "manage_billing");
      const [brandRes, subs, metaConnection, whatsappConnection] = await Promise.all([
        // White-label branding (enterprise): read tier + branding for the
        // active business; effectiveBranding gates on tier so a downgraded
        // tenant's stored branding goes dormant automatically.
        db.from("businesses").select("tier, branding, hipaa_mode").eq("id", businessId).maybeSingle(),
        graceEligible
          ? db
              .from("subscriptions")
              .select("status, grace_ends_at, wiped_at, cancel_reason, created_at")
              .eq("business_id", businessId)
              .order("created_at", { ascending: false })
              .limit(1)
              .then((r) => r.data)
          : Promise.resolve(null),
        getPublicMetaConnection(businessId).catch((err: unknown) => {
          logger.warn("dashboard layout: meta connection read failed; hiding Messenger nav", {
            businessId,
            error: err instanceof Error ? err.message : String(err)
          });
          return null;
        }),
        getPublicWhatsAppConnection(businessId).catch((err: unknown) => {
          logger.warn("dashboard layout: whatsapp connection read failed; hiding WhatsApp nav", {
            businessId,
            error: err instanceof Error ? err.message : String(err)
          });
          return null;
        })
      ]);

      const brandRow = brandRes.data;
      brand = effectiveBranding(brandRow?.tier as string | undefined, brandRow?.branding);
      // Automatic logoff (45 CFR 164.312(a)(2)(iii)) arms for this tenant only.
      // Read from the same row as branding, so it costs no extra round-trip.
      hipaaMode = (brandRow as { hipaa_mode?: boolean } | null)?.hipaa_mode === true;

      const subscription = ((subs ?? []) as EmbeddedSubscriptionRow[])[0] ?? null;
      if (subscription?.grace_ends_at && isCanceledInGrace(subscription)) {
        grace = {
          graceEndsAt: subscription.grace_ends_at,
          reason: subscription.cancel_reason as CancelReason | null
        };
      }

      // is_active matters too: a soft-paused integration stops webhook
      // routing and sends, so the inbox must disappear with it.
      metaConnected = metaConnection?.status === "active" && metaConnection.is_active === true;
      whatsappConnected = whatsappConnection?.is_active === true;
    }
  }

  // Conditional items (Messenger inbox) only render for businesses with an
  // ACTIVE Meta connection, a read hiccup hides rather than breaks nav.
  const sidebarLayout = filterSidebarItemsForBusiness(await sidebarLayoutPromise, {
    metaConnected,
    whatsappConnected
  });

  const requireAcceptance = await acceptancePromise;

  return (
    // SectionMessages ships the dashboard's client translation subset;
    // mapping and guard test live in src/i18n/client-messages.ts.
    <SectionMessages section="dashboard">
    <div className="flex h-dvh bg-deep-ink">
      <DashboardSidebar
        userEmail={viewAs ? ownerEmail : user.email}
        businessId={businessId}
        brand={brand}
        layout={sidebarLayout}
      />
      <main data-app-main className="flex-1 overflow-y-auto p-4 pt-16 lg:p-6">
        <BusinessSwitcher
          businesses={accessible.map((b) => ({
            businessId: b.businessId,
            name: b.name,
            role: b.role
          }))}
          activeBusinessId={businessId}
        />
        {viewAs && (
          <ViewAsBanner
            businessId={viewAs.businessId}
            businessName={viewAs.name}
            tier={viewAs.tier}
            selfOwned={viewAs.selfOwned}
          />
        )}
        {grace && (
          <div className="mb-6">
            <GraceBanner graceEndsAt={grace.graceEndsAt} reason={grace.reason} />
          </div>
        )}
        {/* Asks once per device, then never again: any decision ends it. The
            permanent opt-in stays on the notifications settings page. Not
            shown while the terms gate is up, which owns the screen. */}
        {businessId && !requireAcceptance && <PushOptInBanner businessId={businessId} />}
        {hipaaMode && <HipaaIdleLogout />}
        {requireAcceptance && <TermsAcceptanceGate />}
        {children}
      </main>
      {/* Ask AI companion: the same conversation as /dashboard/chat, on
          every page. Hidden on the chat page itself (inside the launcher),
          and NOT mounted while the terms clickwrap is due: the panel
          shares z-50 with the gate and must never paint over it (Bugbot
          Medium on PR #1383). Deliberately NOT gated on view-as: the full
          /dashboard/chat page already works while impersonating, so the
          companion mirrors it. The chat API stays the authority on what an
          impersonating admin can do (their email resolves no role on a
          foreign tenant, so role-gated bridge tools never declare). */}
      {businessId && !requireAcceptance && <CompanionLauncher businessId={businessId} />}
      {/* Renders nothing. Keeps an already-opted-in browser's push
          subscription registered and fresh, and re-subscribes it if the VAPID
          key rotated. It never prompts for permission: that needs a user
          gesture and lives behind the button in PushSetupCard. */}
      {businessId && !requireAcceptance && <PushRegistrar businessId={businessId} />}
    </div>
    </SectionMessages>
  );
}
