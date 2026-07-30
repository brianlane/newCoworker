import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ADMIN_LOGIN_PATH, isAal2, safeAdminNextPath } from "@/lib/auth/admin-aal";
import AdminMfaForm from "./AdminMfaForm";

export const metadata: Metadata = {
  title: "Admin MFA | New Coworker",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function AdminMfaPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const destination = safeAdminNextPath(params.next);
  const user = await getAuthUser();
  // Send unauthenticated visitors to login with the final destination, not
  // /admin/mfa itself (safeAdminNextPath would collapse that to dashboard).
  if (!user) {
    redirect(`${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(destination)}`);
  }
  if (!user.isAdmin) redirect(ADMIN_LOGIN_PATH);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (isAal2(data?.currentLevel)) {
    redirect(destination);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-parchment">Admin verification</h1>
          <p className="text-sm text-parchment/50">
            Multi-factor authentication is required before opening the admin
            console.
          </p>
        </div>
        <Suspense fallback={null}>
          <AdminMfaForm email={user.email} />
        </Suspense>
      </div>
    </div>
  );
}
