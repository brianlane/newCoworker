import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type AdminLoginPageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

export default async function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const user = await getAuthUser();
  const { next } = await searchParams;
  const nextPath = next && next.startsWith("/") ? next : "/admin";

  if (user?.isAdmin) {
    redirect(nextPath);
  }

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-parchment">Admin Sign In</h1>
          <p className="mt-2 text-sm text-parchment/50">
            Use the admin credentials from `.env` to access the admin console.
          </p>
        </div>

        <Card>
          <div className="space-y-4">
            <Link href={`/login?redirectTo=${encodeURIComponent(nextPath)}`}>
              <Button className="w-full">Continue to Login</Button>
            </Link>

            {user && !user.isAdmin && (
              <form action="/api/auth/signout" method="POST">
                <Button type="submit" variant="ghost" className="w-full">
                  Sign out current non-admin account
                </Button>
              </form>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
