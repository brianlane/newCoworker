import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import LoginForm from "./LoginForm";

type LoginPageProps = {
  searchParams: Promise<{
    redirectTo?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getAuthUser();
  const { redirectTo } = await searchParams;

  // Already signed in: skip the form and land in the app, mirroring
  // /admin/login and /onboard. Admins reaching /dashboard are forwarded to
  // /admin/dashboard by the middleware. A redirectTo aimed back at /login
  // would bounce off this guard again, so those go to the dashboard too.
  if (user) {
    const target = safeInternalPath(redirectTo, "/dashboard");
    redirect(/^\/login($|[/?#])/.test(target) ? "/dashboard" : target);
  }

  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
