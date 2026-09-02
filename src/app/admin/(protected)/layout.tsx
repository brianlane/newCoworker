import type { Viewport } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { adminMfaRedirectPath, isAal2, safeAdminNextPath } from "@/lib/auth/admin-aal";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { SectionMessages } from "@/components/i18n/SectionMessages";
import { PushRegistrar } from "@/components/push/PushRegistrar";
import { newestOwnedBusinessId } from "@/lib/push/eligibility";

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

  // Silent refresh of the admin's own HQ tenant push row. /admin has no
  // view-as pin, but it is where the operator lives, and without this the
  // HQ subscription would only stay fresh while they had HQ's dashboard
  // open. Never prompts; permission already granted is the only path.
  const hqBusinessId = await newestOwnedBusinessId(user.email);

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
        {hqBusinessId && <PushRegistrar businessId={hqBusinessId} />}
      </div>
    </SectionMessages>
  );
}
