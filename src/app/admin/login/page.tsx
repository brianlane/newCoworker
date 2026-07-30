import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import {
  adminMfaRedirectPath,
  isAal2,
  safeAdminNextPath
} from "@/lib/auth/admin-aal";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import AdminLoginForm from "./AdminLoginForm";

type AdminLoginPageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

export default async function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const user = await getAuthUser();
  const { next } = await searchParams;
  const nextPath = safeAdminNextPath(next);

  // Already an admin: honor MFA before any console deep link.
  if (user?.isAdmin) {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (isAal2(data?.currentLevel)) {
      redirect(nextPath);
    }
    redirect(adminMfaRedirectPath(nextPath));
  }

  const adminEmailMissing = !process.env.ADMIN_EMAIL;
  const forceSignOut = !!user && !user.isAdmin;

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-parchment">Admin Sign In</h1>
        </div>

        <Suspense>
          <AdminLoginForm
            forceSignOut={forceSignOut}
            adminEmailMissing={adminEmailMissing}
          />
        </Suspense>
      </div>
    </div>
  );
}
