import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { adminMfaRedirectPath, isAal2 } from "@/lib/auth/admin-aal";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

// See dashboard layout: scope `cover` to the h-dvh shell segments only so the
// safe-area padding can keep the nav + content clear of the notch.
export const viewport: Viewport = {
  viewportFit: "cover"
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/admin/login?next=/admin/dashboard");
  if (!user.isAdmin) redirect("/admin/login?next=/admin/dashboard");

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!isAal2(data?.currentLevel)) {
    redirect(adminMfaRedirectPath("/admin/dashboard"));
  }

  return (
    <div className="flex h-dvh bg-deep-ink">
      <AdminSidebar userEmail={user.email} />
      <main data-app-main className="flex-1 overflow-y-auto p-4 pt-16 lg:p-6">
        {children}
      </main>
    </div>
  );
}
