import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
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
import { logger } from "@/lib/logger";
import { can } from "@/lib/authz/policy";
import { effectiveBranding, type Branding } from "@/lib/plans/branding";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { ViewAsBanner } from "@/components/admin/ViewAsBanner";

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
  // unimpersonated — no banner, no exit. Send them back to the admin panel;
  // the leftover cookie is inert (isViewAsActive keys off the same resolution)
  // and is overwritten by the next "View as tenant" or expires on its own.
  if (user.isAdmin && !viewAs) redirect("/admin/dashboard");

  let grace:
    | { graceEndsAt: string; reason: Parameters<typeof GraceBanner>[0]["reason"] }
    | null = null;
  let businessId: string | null = null;
  let accessible: AccessibleBusiness[] = [];
  let brand: Branding | null = null;
  if (ownerEmail) {
    // Single-round-trip grace lookup. Next.js layouts re-execute on every
    // navigation under `/dashboard`, so we previously paid 2 sequential
    // DB round-trips per page render (businesses lookup + subscriptions
    // lookup) for every signed-in user — even on pages unrelated to
    // billing (soul editor, voice usage, etc.). Fold both lookups into
    // one PostgREST query that selects the most recent business by
    // owner_email and embeds the subscriptions for that business in the
    // same response. We then pick the most recent subscription on the
    // server before deciding whether to render `<GraceBanner />`.
    const db = await createSupabaseServiceClient();
    // If the owner just confirmed an account-email change (possibly on another
    // device, or via a plain password sign-in that never hit /api/auth/callback),
    // mirror the new email onto their business BEFORE the owner_email lookup
    // below — otherwise that lookup would miss and the dashboard would render as
    // if they had no business. No-op (one cheap PK read) when nothing is
    // pending. Skipped during view-as: the admin's pending email change (if
    // any) must not be reconciled onto the impersonated tenant's business.
    if (!viewAs && user.email) {
      await reconcilePendingEmailChange(user.userId, user.email, db);
      // First-login binding for team invites: flip INVITED business_members
      // rows addressed to this email to active with the auth user id stamped.
      // Same layout-render-write precedent as reconcilePendingEmailChange —
      // a cheap indexed no-op for everyone without a pending invite. Best-
      // effort: a hiccup here must never take down the dashboard.
      try {
        await bindBusinessMemberUser(user.userId, user.email, db);
      } catch {
        // Next render retries; membership stays 'invited' meanwhile.
      }
    }
    // Multi-business (agency) resolution: owned businesses ∪ memberships,
    // with the switcher cookie picking the active one (validated against the
    // accessible set on every read). Admin view-as resolves to its pinned
    // business inside the helper, unchanged.
    const ctx = await resolveActiveBusinessContext(user, db);
    businessId = ctx.businessId;
    accessible = ctx.accessible;
    // White-label branding (enterprise): read tier + branding for the active
    // business; effectiveBranding gates on tier so a downgraded tenant's
    // stored branding goes dormant automatically.
    if (businessId) {
      const { data: brandRow } = await db
        .from("businesses")
        .select("tier, branding")
        .eq("id", businessId)
        .maybeSingle();
      brand = effectiveBranding(brandRow?.tier as string | undefined, brandRow?.branding);
    }
    // The grace banner's CTA is /api/billing/reactivate (manage_billing,
    // owner-only) — don't dangle it in front of managers/staff whose click
    // would just 403. Billing state is the owner's concern.
    if (businessId && ctx.role && can(ctx.role, "manage_billing")) {
      const { data: subs } = await db
        .from("subscriptions")
        .select("status, grace_ends_at, wiped_at, cancel_reason, created_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1);
      const subscription = ((subs ?? []) as EmbeddedSubscriptionRow[])[0] ?? null;
      if (subscription?.grace_ends_at && isCanceledInGrace(subscription)) {
        grace = {
          graceEndsAt: subscription.grace_ends_at,
          reason: subscription.cancel_reason as CancelReason | null
        };
      }
    }
  }

  // Per-user nav customization (order + visibility). Keyed to the SIGNED-IN
  // user (not the tenant), so an admin in view-as sees their own layout.
  // Degrades to the default catalog on any read hiccup inside the helper.
  // Conditional items (Messenger inbox) only render for businesses with an
  // ACTIVE Meta connection — a read hiccup hides rather than breaks nav.
  let metaConnected = false;
  if (businessId) {
    try {
      const metaConnection = await getPublicMetaConnection(businessId);
      // is_active matters too: a soft-paused integration stops webhook
      // routing and sends, so the inbox must disappear with it.
      metaConnected = metaConnection?.status === "active" && metaConnection.is_active;
    } catch (err) {
      logger.warn("dashboard layout: meta connection read failed; hiding Messenger nav", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const sidebarLayout = filterSidebarItemsForBusiness(
    await getSidebarLayout(user.userId),
    { metaConnected }
  );

  return (
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
          />
        )}
        {grace && (
          <div className="mb-6">
            <GraceBanner graceEndsAt={grace.graceEndsAt} reason={grace.reason} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
