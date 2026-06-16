import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { rateLimit, RATE_LIMITS, type RateLimitConfig } from "@/lib/rate-limit";

type AuthUser = {
  id: string;
  email: string | null;
};

// Routes that require an authenticated session. /onboard/success is
// intentionally NOT here: the post-questionnaire flow goes Stripe-first
// (anonymous /onboard/questionnaire Step 3 → /api/business/create with an
// onboarding token → /api/checkout → Stripe → /onboard/success), and the
// account is then minted server-side via
// `auth.admin.createUser({ email_confirm: true })` in
// /api/onboard/set-password. Gating /onboard/success on auth would force a
// pre-payment email-confirmation roundtrip (the source of Vercel's 494
// REQUEST_HEADER_TOO_LARGE on chunked-cookie accumulation) and contradicts
// the OrderSummaryCard copy that promises "create your password and confirm
// your email" AFTER payment.
const protectedPrefixes = ["/dashboard"];

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

function normalizeHostname(hostname: string): string {
  const h = hostname.replace(/^www\./, "").toLowerCase();
  if (h === "127.0.0.1" || h === "::1") {
    return "localhost";
  }
  return h;
}

function originsMatch(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const hostA = normalizeHostname(a.hostname);
    const hostB = normalizeHostname(b.hostname);
    return a.protocol === b.protocol && hostA === hostB && a.port === b.port;
  } catch {
    return false;
  }
}

/** Derive the canonical origin for this incoming request (preview/prod/local). */
function requestOwnOrigin(request: NextRequest): string | null {
  const host = request.headers.get("host") ?? request.nextUrl.host;
  if (!host) return null;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.nextUrl.protocol.replace(":", "");
  return `${scheme}://${host}`;
}

/** True when Origin/Referer matches this deployment's own URL (fixes Preview vs NEXT_PUBLIC_APP_URL mismatch). */
function sourceMatchesRequestOrigin(request: NextRequest, source: string): boolean {
  const own = requestOwnOrigin(request);
  if (!own) return false;
  return originsMatch(source, own);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  // --- CSRF protection for state-changing API requests (skip webhooks) ---
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/webhooks/") &&
    !pathname.startsWith("/api/rowboat") &&
    // /api/voice/tools/* are server-to-server tool adapters authenticated
    // solely by `Authorization: Bearer ROWBOAT_GATEWAY_TOKEN` (gatewayGuard),
    // never by a session cookie. CSRF only defends cookie-authed browser
    // requests, so it adds no protection here and instead 403s legitimate
    // callers that send no Origin (the VPS voice-bridge and chat-worker).
    // Same rationale as the /api/rowboat and /api/webhooks exemptions above.
    !pathname.startsWith("/api/voice/tools/") &&
    // /api/internal/* are server-to-server cron/worker endpoints
    // authenticated solely by `Authorization: Bearer INTERNAL_CRON_SECRET`
    // (assertCronAuth), never by a session cookie. The VPS chat-worker's
    // rolling-summary callback (/api/internal/dashboard-chat-summarize)
    // sends no Origin header, so CSRF was 403ing it on every turn and
    // silently disabling thread summarization. Same rationale as the
    // /api/voice/tools, /api/rowboat, and /api/webhooks exemptions above.
    !pathname.startsWith("/api/internal/") &&
    // /api/integrations/custom/credentials is a server-to-server endpoint
    // authenticated solely by `Authorization: Bearer ROWBOAT_GATEWAY_TOKEN`
    // (gatewayGuard) — the per-tenant render service (vps/aiflow-render) POSTs
    // it to fetch a stored integration's decrypted credentials before driving a
    // login form. It sends no Origin header, so CSRF would 403 it. Same
    // rationale as the /api/voice/tools, /api/internal, /api/rowboat, and
    // /api/webhooks exemptions above.
    pathname !== "/api/integrations/custom/credentials" &&
    // /api/aiflows/send-owner-email is a server-to-server endpoint authenticated
    // solely by `Authorization: Bearer ROWBOAT_GATEWAY_TOKEN` (gatewayGuard) — the
    // ai-flow-worker Edge Function POSTs it to send email from an owner's
    // Nango-connected mailbox (send_email.fromConnectionId / SMS quiet-hours
    // email fallback). It sends no Origin header, so CSRF would 403 every send.
    // Same rationale as the exemptions above.
    pathname !== "/api/aiflows/send-owner-email" &&
    // /api/email/inbound is the per-tenant AI mailbox webhook authenticated
    // solely by `Authorization: Bearer EMAIL_INBOUND_SECRET` (assertEmailInboundAuth)
    // — the Cloudflare Email Worker POSTs every inbound message here with no Origin
    // header, so CSRF would 403 all inbound mail. Same rationale as the exemptions
    // above.
    pathname !== "/api/email/inbound" &&
    ["POST", "PUT", "DELETE", "PATCH"].includes(method)
  ) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000";
    const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;

    let originValid = false;
    const checkSource = origin || referer;
    if (checkSource) {
      originValid = sourceMatchesRequestOrigin(request, checkSource);
      if (!originValid) {
        originValid = originsMatch(checkSource, expectedOrigin);
      }
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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  let user: AuthUser | null = null;

  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll().map(({ name, value }) => ({ name, value }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set({ name, value, ...(options ?? {}) });
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set({ name, value, ...(options ?? {}) });
          });
        },
      },
    });

    // Use getClaims() instead of getUser() here. getClaims verifies the JWT
    // locally (against the project's asymmetric signing keys) when possible,
    // avoiding a network round-trip to Supabase Auth on EVERY matched request
    // — the single biggest middleware TTFB cost. It still refreshes the
    // session via the cookie setAll above when the token is near expiry. The
    // claims carry the same `sub` (user id) and `email` we need for the
    // admin / protected-route gates below.
    const { data, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError) {
      console.error("[proxy] supabase.auth.getClaims failed:", claimsError.message);
    }
    const claims = data?.claims ?? null;
    const claimSub = typeof claims?.sub === "string" ? claims.sub : null;
    const claimEmail = typeof claims?.email === "string" ? claims.email : null;
    user = claimSub ? { id: claimSub, email: claimEmail } : null;
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
      redirectUrl.pathname = "/admin/dashboard";
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
      redirectUrl.pathname = "/admin/dashboard";
      return redirectWithCookies(response, redirectUrl);
    }
  }

  // --- Protected route gate (owner dashboard) ---
  if (isProtectedRoute(pathname) && !user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("redirectTo", pathname);
    return redirectWithCookies(response, redirectUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo.png|.*\\.svg).*)",
  ],
};
