import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name) {
        return request.cookies.get(name)?.value;
      },
      set(name, value, options) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value, ...options });
      },
      remove(name, options) {
        request.cookies.set({ name, value: "", ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value: "", ...options });
      }
    }
  });

  const { data: { user } } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAdminLogin = pathname.startsWith("/admin/login");
  const isAdminRoute = pathname.startsWith("/admin");
  const protectedPaths = ["/dashboard"];
  const isProtected = protectedPaths.some((p) => pathname.startsWith(p)) || (isAdminRoute && !isAdminLogin);

  if (isProtected && !user) {
    const redirectUrl = request.nextUrl.clone();
    if (isAdminRoute && !isAdminLogin) {
      redirectUrl.pathname = "/admin/login";
      redirectUrl.searchParams.set("next", pathname);
    } else {
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("redirectTo", pathname);
    }
    return NextResponse.redirect(redirectUrl);
  }

  // Gate /admin to ADMIN_EMAIL only
  if (isAdminRoute && !isAdminLogin) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail || user?.email?.toLowerCase() !== adminEmail.toLowerCase()) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  // Mirror reality behavior: authenticated admin should not stay on admin login page.
  if (isAdminLogin) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && user?.email?.toLowerCase() === adminEmail.toLowerCase()) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }
  }

  return response;
}
