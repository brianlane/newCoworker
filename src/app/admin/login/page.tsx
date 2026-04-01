import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import AdminLoginForm from "./AdminLoginForm";

type AdminLoginPageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

export default async function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const user = await getAuthUser();
  const { next } = await searchParams;
  const nextPath = next && next.startsWith("/") ? next : "/admin/dashboard";

  // Already an admin — redirect straight in
  if (user?.isAdmin) {
    redirect(nextPath);
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
