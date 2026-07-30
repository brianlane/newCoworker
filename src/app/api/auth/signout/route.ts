import { VIEW_AS_COOKIE } from "@/lib/admin/view-as";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();

  const adminEmail = process.env.ADMIN_EMAIL;
  const isAdmin =
    !!adminEmail &&
    !!data.user?.email &&
    data.user.email.toLowerCase() === adminEmail.toLowerCase();

  await supabase.auth.signOut();

  // Use the request's own origin so redirects work in both local and prod
  const origin = new URL(request.url).origin;
  const destination = isAdmin ? "/admin/login" : "/login";

  const response = NextResponse.redirect(new URL(destination, origin), 303);
  // Drop any leftover admin view-as cookie so the next admin login cannot
  // reuse it as a dashboard routing exception.
  response.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
