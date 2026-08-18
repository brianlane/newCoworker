import { VIEW_AS_COOKIE } from "@/lib/admin/view-as";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_TIMEOUT_ERROR } from "@/lib/hipaa/session-timeout";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();

  const adminEmail = process.env.ADMIN_EMAIL;
  const isAdmin =
    !!adminEmail &&
    !!data.user?.email &&
    data.user.email.toLowerCase() === adminEmail.toLowerCase();

  // Why the session ended, so the login page can say so. WHITELISTED, never
  // reflected: this value lands in a URL, and echoing arbitrary form input
  // into a redirect is how open-redirect and injected-message bugs start.
  // Only the HIPAA idle logout sets it (src/components/dashboard/HipaaIdleLogout.tsx).
  let reason: string | null = null;
  try {
    const form = await request.formData();
    if (form.get("reason") === SESSION_TIMEOUT_ERROR) reason = SESSION_TIMEOUT_ERROR;
  } catch {
    // No form body (the plain sign-out button posts one, but a bare POST is
    // still a valid sign-out): fall through with no reason.
  }

  await supabase.auth.signOut();

  // Use the request's own origin so redirects work in both local and prod
  const origin = new URL(request.url).origin;
  const base = isAdmin ? "/admin/login" : "/login";
  const destination = reason ? `${base}?error=${reason}` : base;

  const response = NextResponse.redirect(new URL(destination, origin), 303);
  // Drop any leftover admin view-as cookie so the next admin login cannot
  // reuse it as a dashboard routing exception.
  response.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
