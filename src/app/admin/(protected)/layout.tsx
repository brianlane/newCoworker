import type { Viewport } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { adminMfaRedirectPath, isAal2, safeAdminNextPath } from "@/lib/auth/admin-aal";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { SectionMessages } from "@/components/i18n/SectionMessages";
import { PushRegistrar } from "@/components/push/PushRegistrar";

// See dashboard layout: scope `cover` to the h-dvh shell segments only so the
// safe-area padding can keep the nav + content clear of the notch.
export const viewport: Viewport = {
  viewportFit: "cover"
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers();
  const requestedPath = safeAdminNextPath(headerStore.get("x-pathname"));
  const user = await getAuthUser();
  if (!user) redirect(`/admin/login?next=${encodeURIComponent(requestedPath)}`);
  if (!user.isAdmin) redirect(`/admin/login?next=${encodeURIComponent(requestedPath)}`);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!isAal2(data?.currentLevel)) {
    redirect(adminMfaRedirectPath(requestedPath));
  }

  return (
    // SectionMessages ships the admin client translation subset (including
    // `marketing.contactPage` for the white-glove intake's ContactForm);
    // mapping and guard test live in src/i18n/client-messages.ts.
    <SectionMessages section="admin">
      <div className="flex h-dvh bg-deep-ink">
        <AdminSidebar userEmail={user.email} />
        <main data-app-main className="flex-1 overflow-y-auto p-4 pt-16 lg:p-6">
          {children}
        </main>
        {/*
          Platform scope: businessId NULL, the device set that belongs to no
          tenant. This is what makes an HQ admin reachable for the alerts
          addressed to US (a customer unreachable, an alert that reached
          nobody) rather than to a customer.

          Safe to mount unconditionally here. The registrar never prompts: it
          only re-creates a subscription where permission is ALREADY granted,
          and it honours the per-device opt-out. Everything above has already
          gated this layout on isAdmin plus AAL2, which is the same bar
          /api/push/subscribe enforces for the null scope.

          An admin who also owns a business ends up with two rows for one
          browser, one per scope. That is deliberate, and it is why the unique
          index is NULLS NOT DISTINCT.
        */}
        <PushRegistrar businessId={null} />
      </div>
    </SectionMessages>
  );
}
