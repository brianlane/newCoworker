import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { rateLimit, RATE_LIMITS, type RateLimitConfig } from "@/lib/rate-limit";

type AuthUser = {
  id: string;
  email: string | null;
};

const protectedPrefixes = ["/dashboard", "/onboard/checkout", "/onboard/success"];

function isProtectedRoute(pathname: string) {
  return protectedPrefixes.some((p) => pathname.startsWith(p));
}

function redirectWithCookies(response: NextResponse, url: URL): NextResponse {
  const redirectResponse = NextResponse.redirect(url);
  response.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });
  return redirectResponse;
}

function getIdentifier(request: NextRequest, configKey: keyof typeof RATE_LIMITS) {
  const realIp = request.headers.get("x-real-ip");
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = realIp?.trim() || forwarded?.split(",")[0]?.trim() || "anonymous";

  if (configKey === "API") {
    return `${ip}:${configKey.toLowerCase()}:${request.nextUrl.pathname}`;
  }
  return `${ip}:${configKey.toLowerCase()}`;
}

function originsMatch(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const hostA = a.hostname.replace(/^www\./, "");
    const hostB = b.hostname.replace(/^www\./, "");
    return a.protocol === b.protocol && hostA === hostB && a.port === b.port;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  // --- CSRF protection for state-changing API requests (skip webhooks) ---
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/webhooks/") &&
    !pathname.startsWith("/api/rowboat") &&
    ["POST", "PUT", "DELETE", "PATCH"].includes(method)
  ) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;

    let originValid = false;
    const checkSource = origin || referer;
    if (checkSource) {
      originValid = originsMatch(checkSource, expectedOrigin);
      if (!originValid && vercelUrl) {
        originValid = originsMatch(checkSource, vercelUrl);
      }
      if (!originValid && process.env.NODE_ENV === "development") {
        originValid = originsMatch(checkSource, "http://localhost:3000");
      }
    }

    if (!originValid) {
      return new NextResponse(
        JSON.stringify({ error: "FORBIDDEN", message: "CSRF validation failed" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // --- Rate limiting ---
  let configKey: keyof typeof RATE_LIMITS = "API";
  if (pathname.includes("/api/webhooks/")) {
    configKey = "WEBHOOK";
  } else if (
    method === "POST" &&
    (pathname.includes("/login") || pathname.includes("/api/auth"))
  ) {
    configKey = "AUTH";
  }

  const rlConfig: RateLimitConfig = RATE_LIMITS[configKey];
  const identifier = getIdentifier(request, configKey);
  const rlResult = rateLimit(identifier, rlConfig);

  if (!rlResult.success) {
    return new NextResponse(
      JSON.stringify({
        error: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded. Please try again later.",
        retryAfter: Math.ceil((rlResult.reset - Date.now()) / 1000),
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((rlResult.reset - Date.now()) / 1000)),
          "X-RateLimit-Limit": String(rlResult.limit),
          "X-RateLimit-Remaining": String(rlResult.remaining),
          "X-RateLimit-Reset": String(rlResult.reset),
        },
      },
    );
  }

  // --- Supabase session refresh ---
  let response = NextResponse.next({ request });

  response.headers.set("X-RateLimit-Limit", String(rlResult.limit));
  response.headers.set("X-RateLimit-Remaining", String(rlResult.remaining));
  response.headers.set("X-RateLimit-Reset", String(rlResult.reset));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let user: AuthUser | null = null;

  if (supabaseUrl && supabaseAnonKey) {
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
        },
      },
    });

    const { data: { user: supabaseUser } } = await supabase.auth.getUser();
    user = supabaseUser ? { id: supabaseUser.id, email: supabaseUser.email ?? null } : null;
  }

  // --- Admin route protection ---
  const isAdminRoute = pathname.startsWith("/admin");
  const isAdminLogin = pathname.startsWith("/admin/login");

  if (isAdminRoute && !isAdminLogin) {
    const adminEmail = process.env.ADMIN_EMAIL;
    const isAdmin =
      user?.email && adminEmail
        ? user.email.toLowerCase() === adminEmail.toLowerCase()
        : false;

    if (!isAdmin) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/admin/login";
      redirectUrl.searchParams.set("next", pathname);
      return redirectWithCookies(response, redirectUrl);
    }
  }

  // Redirect authenticated admin away from /admin/login
  if (isAdminLogin && user) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && user.email?.toLowerCase() === adminEmail.toLowerCase()) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/admin";
      return redirectWithCookies(response, redirectUrl);
    }
  }

  // Redirect admin users away from owner dashboard
  if (isProtectedRoute(pathname) && user) {
    const adminEmail = process.env.ADMIN_EMAIL;
    const isAdmin =
      user.email && adminEmail
        ? user.email.toLowerCase() === adminEmail.toLowerCase()
        : false;
    if (isAdmin) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/admin";
      return redirectWithCookies(response, redirectUrl);
    }
  }

  // --- Protected route gate (owner dashboard) ---
  if (isProtectedRoute(pathname) && !user) {
    const redirectUrl = request.nextUrl.clone();
    if (pathname.startsWith("/onboard/checkout")) {
      redirectUrl.pathname = "/signup";
      redirectUrl.searchParams.set("redirectTo", pathname);
    } else {
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("redirectTo", pathname);
    }
    return redirectWithCookies(response, redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo.png|.*\\.svg).*)",
  ],
};
