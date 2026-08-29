import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { rateLimit, RATE_LIMITS, type RateLimitConfig } from "@/lib/rate-limit";
import { LOCALE_COOKIE } from "@/i18n/routing";
import { isSpanishMarketingPath, stripSpanishPrefix } from "@/lib/i18n/es-routes";
import { classifyAiTraffic, recordAiTrafficEvent } from "@/lib/marketing/ai-traffic";
import { isMcpRoutePath } from "@/lib/mcp/routes";

type AuthUser = {
  id: string;
  email: string | null;
  /** JWT authenticator assurance level (`aal1` / `aal2`). Used for admin MFA. */
  aal: string | null;
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

/**
 * Note the AI crawlers reading us and the humans arriving from AI answers.
 *
 * Here because it is the only place that sees every request WITH its path,
 * before rewrites. The cost on a normal request is two header reads and a
 * string match that fails; only a matched request does any work at all, and
 * that work runs through `waitUntil` so it never delays the response.
 * Recording swallows its own errors.
 */
function noteAiTraffic(request: NextRequest, event?: NextFetchEvent): void {
  // Reads only. A crawler never POSTs, and an AI referral lands as a GET.
  if (request.method !== "GET") return;

  const observed = classifyAiTraffic({
    pathname: request.nextUrl.pathname,
    userAgent: request.headers.get("user-agent"),
    referrer: request.headers.get("referer")
  });
  if (!observed) return;

  const write = recordAiTrafficEvent(observed);
  // `event` is absent when proxy() is called directly (tests, some local
  // paths); awaiting there is wrong and dropping the row is harmless.
  if (event) event.waitUntil(write);
}

export async function proxy(request: NextRequest, event?: NextFetchEvent) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  noteAiTraffic(request, event);

  // --- /es/... SEO mirrors for public marketing pages ---
  // Rewrite to the canonical unprefixed route and pin the locale cookie to
  // Spanish. English URLs are untouched; the UI never sniffs Accept-Language.
  if (isSpanishMarketingPath(pathname)) {
    const canonicalPath = stripSpanishPrefix(pathname);
    // Same limiter as the canonical English path, /es/login POSTs must not
    // dodge the stricter AUTH bucket by riding the mirror.
    const esConfigKey: keyof typeof RATE_LIMITS =
      method === "POST" && canonicalPath.includes("/login") ? "AUTH" : "API";
    const esRlConfig: RateLimitConfig = RATE_LIMITS[esConfigKey];
    const esRlResult = rateLimit(getIdentifier(request, esConfigKey), esRlConfig);
    if (!esRlResult.success) {
      return new NextResponse(
        JSON.stringify({
          error: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Please try again later.",
          retryAfter: Math.ceil((esRlResult.reset - Date.now()) / 1000),
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil((esRlResult.reset - Date.now()) / 1000)),
            "X-RateLimit-Limit": String(esRlResult.limit),
            "X-RateLimit-Remaining": String(esRlResult.remaining),
            "X-RateLimit-Reset": String(esRlResult.reset),
          },
        },
      );
    }
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = canonicalPath;
    const rewrite = NextResponse.rewrite(rewriteUrl);
    rewrite.cookies.set(LOCALE_COOKIE, "es", {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365
    });
    rewrite.headers.set("X-RateLimit-Limit", String(esRlResult.limit));
    rewrite.headers.set("X-RateLimit-Remaining", String(esRlResult.remaining));
    rewrite.headers.set("X-RateLimit-Reset", String(esRlResult.reset));
    return rewrite;
  }

  // --- CSRF protection for state-changing API requests (skip webhooks) ---
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/webhooks/") &&
    !pathname.startsWith("/api/rowboat") &&
    // /api/voice/tools/* are server-to-server tool adapters authenticated
    // solely by a gateway-token bearer bound to the businessId
    // (gatewayBusinessGuard), never by a session cookie. CSRF only defends cookie-authed browser
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
    // authenticated solely by a gateway-token bearer bound to the businessId
    // (gatewayBusinessGuard), the per-tenant render service (vps/aiflow-render) POSTs
    // it to fetch a stored integration's decrypted credentials before driving a
    // login form. It sends no Origin header, so CSRF would 403 it. Same
    // rationale as the /api/voice/tools, /api/internal, /api/rowboat, and
    // /api/webhooks exemptions above.
    pathname !== "/api/integrations/custom/credentials" &&
    // /api/aiflows/send-owner-email is a server-to-server endpoint authenticated
    // solely by a gateway-token bearer bound to the businessId (gatewayBusinessGuard), the
    // ai-flow-worker Edge Function POSTs it to send email from an owner's
    // Nango-connected mailbox (send_email.fromConnectionId / SMS quiet-hours
    // email fallback). It sends no Origin header, so CSRF would 403 every send.
    // Same rationale as the exemptions above.
    pathname !== "/api/aiflows/send-owner-email" &&
    // /api/vps/posture is the box → platform security-posture heartbeat,
    // authenticated solely by a gateway-token bearer bound to the businessId
    // (verifyGatewayTokenForBusiness), heartbeat.sh POSTs it via curl with
    // no Origin header, so CSRF was 403ing every fleet posture report. Same
    // rationale as the /api/voice/tools exemption above.
    pathname !== "/api/vps/posture" &&
    // /api/email/inbound is the per-tenant AI mailbox webhook authenticated
    // solely by `Authorization: Bearer EMAIL_INBOUND_SECRET` (assertEmailInboundAuth),
    // the Cloudflare Email Worker POSTs every inbound message here with no Origin
    // header, so CSRF would 403 all inbound mail. Same rationale as the exemptions
    // above.
    pathname !== "/api/email/inbound" &&
    // /api/telnyx/porting-webhook is Telnyx's porting_order.status_changed
    // delivery, authenticated solely by its Ed25519 signature
    // (verifyTelnyxWebhookSignature), Telnyx sends no Origin header, so
    // CSRF would 403 every status update. Same rationale as the exemptions
    // above.
    pathname !== "/api/telnyx/porting-webhook" &&
    // /api/marketing/unsubscribe is the RFC 8058 one-click unsubscribe
    // target: mail clients (Gmail/Apple Mail) POST it server-to-server with
    // no Origin header, authenticated solely by the per-contact HMAC token
    // in the URL, never by a session cookie. CSRF would 403 the native
    // one-click opt-out, breaking the compliance path campaign mail
    // advertises. Same rationale as the exemptions above.
    pathname !== "/api/marketing/unsubscribe" &&
    // /api/notifications/unsubscribe is the same RFC 8058 one-click target
    // for OPERATOR mail (urgent alerts, the daily/weekly digest, the monthly
    // recap), which advertises List-Unsubscribe-Post exactly as campaign mail
    // does. It is authenticated solely by the business UUID in the URL, never
    // by a session cookie, so CSRF protects nothing here: anyone holding the
    // bid can POST it from their own server without a victim's browser. What
    // the gate DID do was 403 Gmail and Apple Mail's native Unsubscribe
    // control, which is the compliance path the headers promise. Same
    // rationale as /api/marketing/unsubscribe above.
    pathname !== "/api/notifications/unsubscribe" &&
    // /api/public/v1/* is the public REST API (Zapier et al.) authenticated
    // solely by an `Authorization: Bearer nck_…` API key hashed against
    // api_keys (authenticatePublicApiRequest), never by a session cookie.
    // External clients send no Origin header, so CSRF would 403 every call.
    // Same rationale as the exemptions above.
    !pathname.startsWith("/api/public/") &&
    // The MCP endpoints are authenticated solely by a Supabase OAuth
    // access-token bearer (verifySupabaseAccessToken), never by a session
    // cookie. The assistants' servers POST JSON-RPC with no Origin header, so
    // CSRF would 403 every tool call. Same rationale as the /api/public
    // exemption above. Matched exactly against the known routes rather than
    // by "/api/mcp" prefix, so a future /api/mcp/* route is not silently
    // exempted before anyone decides it should be.
    !isMcpRoutePath(pathname) &&
    // /api/widget/* is the website chat widget API, authenticated solely by
    // the tenant's public site key (ncw_pub_…) + a per-session bearer
    // (ncws_…), never by a session cookie, so CSRF adds no protection.
    // The iframe is same-origin (its fetches would usually pass anyway),
    // but privacy tooling can blank Origin/Referer inside embedded frames
    // and CSRF must not 403 legitimate visitors. Same rationale as
    // /api/public/ above.
    !pathname.startsWith("/api/widget/") &&
    // /api/book/* is the public self-serve booking page API, authenticated
    // solely by the page's capability token (ncb_…), never by a session
    // cookie, so CSRF adds no protection. Visitors arrive from shared links
    // and privacy tooling can blank Origin/Referer; CSRF must not 403 a
    // legitimate booking. Same rationale as /api/widget/ above.
    !pathname.startsWith("/api/book/") &&
    // /api/security/csp-report is the browser's own CSP violation reporter.
    // The browser posts it directly, not from page script, and sends no
    // Origin, so CSRF would 403 every report and the report-only bake would
    // silently collect nothing. It authenticates nothing and mutates nothing;
    // it only writes a capped log line. Same rationale as /api/book/ above.
    pathname !== "/api/security/csp-report" &&
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
  } else if (pathname === "/api/security/csp-report") {
    configKey = "CSP_REPORT";
  } else if (
    method === "POST" &&
    (pathname.includes("/login") || pathname.includes("/api/auth"))
  ) {
    // KNOWN-INERT (CASA DAST triage, 2026-07-31): login never passes through
    // this proxy. The browser calls supabase.auth.signInWithPassword directly
    // (LoginForm/AdminLoginForm), and the only /api/auth routes are signout
    // and callback, so this bucket sees no credential traffic. Supabase
    // Auth's own limits are the real auth rate control; do not "harden" this
    // bucket expecting it to protect login.
    configKey = "AUTH";
  }

  const rlConfig: RateLimitConfig = RATE_LIMITS[configKey];
  const identifier = getIdentifier(request, configKey);
  const rlResult = rateLimit(identifier, rlConfig);

  if (!rlResult.success) {
    // A CSP violation reporter is not a caller we can hand an error to: the
    // browser cannot act on it, and a 429 with Retry-After makes it retry,
    // amplifying exactly the traffic the cap exists to contain. Drop quietly.
    if (configKey === "CSP_REPORT") {
      return new NextResponse(null, { status: 204 });
    }
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
  // Forward path+query so RSC admin layouts can preserve deep links when
  // redirecting AAL1 admins to /admin/mfa.
  const pathWithQuery = `${pathname}${request.nextUrl.search}`;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathWithQuery);
  let response = NextResponse.next({
    request: { headers: requestHeaders }
  });

  response.headers.set("X-RateLimit-Limit", String(rlResult.limit));
  response.headers.set("X-RateLimit-Remaining", String(rlResult.remaining));
  response.headers.set("X-RateLimit-Reset", String(rlResult.reset));

  // Only routes that actually consume the session need the Supabase work
  // below (client construction + getClaims + cookie refresh). Public
  // marketing pages (/, /pricing, /features, /faq, …) never read the
  // session server-side, so paying the auth cost there on EVERY anonymous
  // page view was pure TTFB overhead. The refresh must stay on:
  //   - /dashboard, /admin: the auth gates below consume `user`.
  //   - /api: cookie-authed route handlers rely on the middleware having
  //     refreshed a near-expiry session (the canonical @supabase/ssr shape).
  //   - /oauth (consent) and /contact: server components that call
  //     getAuthUser() themselves. An RSC cannot persist a rotated refresh
  //     token (cookies are read-only there), so skipping the middleware
  //     refresh on these would burn refresh-token rotations and eventually
  //     trip reuse detection, logging the user out.
  // Login/signup/onboard pages authenticate via the browser client (which
  // manages its own cookies) and need nothing from the middleware.
  const consumesSession =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/oauth") ||
    pathname.startsWith("/contact");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  let user: AuthUser | null = null;

  if (consumesSession && supabaseUrl && supabaseAnonKey) {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll().map(({ name, value }) => ({ name, value }));
        },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              request.cookies.set({ name, value, ...(options ?? {}) });
            });
            const refreshedHeaders = new Headers(request.headers);
            refreshedHeaders.set("x-pathname", pathWithQuery);
            response = NextResponse.next({
              request: { headers: refreshedHeaders }
            });
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set({ name, value, ...(options ?? {}) });
            });
          },
      },
    });

    // Use getClaims() instead of getUser() here. getClaims verifies the JWT
    // locally (against the project's asymmetric signing keys) when possible,
    // avoiding a network round-trip to Supabase Auth on EVERY matched request,
    // the single biggest middleware TTFB cost. It still refreshes the
    // session via the cookie setAll above when the token is near expiry. The
    // claims carry the same `sub` (user id) and `email` we need for the
    // admin / protected-route gates below, plus `aal` for admin MFA.
    const { data, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError) {
      console.error("[proxy] supabase.auth.getClaims failed:", claimsError.message);
    }
    const claims = data?.claims ?? null;
    const claimSub = typeof claims?.sub === "string" ? claims.sub : null;
    const claimEmail = typeof claims?.email === "string" ? claims.email : null;
    const claimAal = typeof claims?.aal === "string" ? claims.aal : null;
    user = claimSub ? { id: claimSub, email: claimEmail, aal: claimAal } : null;
  }

  // --- Admin route protection ---
  // CASA 3.3.1: /admin/* (except login + MFA challenge) requires ADMIN_EMAIL
  // identity AND JWT aal=aal2. AAL1 admins are sent to /admin/mfa.
  const isAdminRoute = pathname.startsWith("/admin");
  const isAdminLogin = pathname.startsWith("/admin/login");
  const isAdminMfa = pathname.startsWith("/admin/mfa");
  const adminEmail = process.env.ADMIN_EMAIL;
  const isAdminUser =
    !!user?.email &&
    !!adminEmail &&
    user.email.toLowerCase() === adminEmail.toLowerCase();
  const adminHasMfa = isAdminUser && user?.aal === "aal2";

  if (isAdminRoute && !isAdminLogin && !isAdminMfa) {
    if (!isAdminUser) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/admin/login";
      redirectUrl.search = "";
      redirectUrl.searchParams.set("next", pathWithQuery);
      return redirectWithCookies(response, redirectUrl);
    }
    if (!adminHasMfa) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/admin/mfa";
      redirectUrl.search = "";
      redirectUrl.searchParams.set("next", pathWithQuery);
      return redirectWithCookies(response, redirectUrl);
    }
  }

  if (isAdminMfa && user && !isAdminUser) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/admin/login";
    return redirectWithCookies(response, redirectUrl);
  }

  if (isAdminMfa && adminHasMfa) {
    const redirectUrl = request.nextUrl.clone();
    const nextParam = request.nextUrl.searchParams.get("next");
    const next =
      nextParam &&
      nextParam.startsWith("/") &&
      !nextParam.startsWith("//") &&
      !nextParam.startsWith("/admin/mfa")
        ? nextParam
        : "/admin/dashboard";
    // Preserve deep links after MFA completes (path may include a query).
    const target = new URL(next, request.nextUrl.origin);
    redirectUrl.pathname = target.pathname;
    redirectUrl.search = target.search;
    return redirectWithCookies(response, redirectUrl);
  }

  // Redirect authenticated admin away from /admin/login
  if (isAdminLogin && isAdminUser) {
    const redirectUrl = request.nextUrl.clone();
    if (adminHasMfa) {
      const nextParam = request.nextUrl.searchParams.get("next");
      const next =
        nextParam &&
        nextParam.startsWith("/") &&
        !nextParam.startsWith("//") &&
        !nextParam.startsWith("/admin/mfa")
          ? nextParam
          : "/admin/dashboard";
      const target = new URL(next, request.nextUrl.origin);
      redirectUrl.pathname = target.pathname;
      redirectUrl.search = target.search;
    } else {
      redirectUrl.pathname = "/admin/mfa";
      const nextParam = request.nextUrl.searchParams.get("next");
      if (nextParam) redirectUrl.searchParams.set("next", nextParam);
    }
    return redirectWithCookies(response, redirectUrl);
  }

  // Redirect admin users away from owner dashboard, UNLESS a view-as
  // session is active (cookie set by POST /api/admin/view-as). The cookie's
  // mere presence only opens this routing gate; the dashboard pages
  // themselves re-validate it against isAdmin + a live business row
  // (src/lib/admin/view-as.ts), so a forged value can't impersonate.
  if (isProtectedRoute(pathname) && user) {
    // View-as is only a routing exception for AAL2 admins. A leftover
    // admin_view_as cookie must not let password-only (AAL1) sessions into
    // the owner dashboard.
    if (isAdminUser && !(adminHasMfa && request.cookies.get("admin_view_as")?.value)) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = adminHasMfa ? "/admin/dashboard" : "/admin/mfa";
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
    // logo-\d+.png are the sized favicon/app-icon variants (logo-32 etc.),
    // static assets the middleware must skip just like logo.png itself.
    //
    // sw.js and manifest.webmanifest are skipped for the same reason plus a
    // sharper one. The browser re-fetches /sw.js on every registration call
    // to check for an update, so a dashboard behind one office NAT spends a
    // shared per-IP API bucket on it; when that trips, the middleware answers
    // with a JSON 429 where the browser expected a script, the worker update
    // fails, and a shipped change silently never reaches those machines. A
    // 429 on the manifest makes the install prompt vanish with nothing in our
    // logs. Neither path reads the session or needs a rate limit, and
    // next.config.ts headers() is a separate matcher that still applies the
    // full security baseline to both.
    "/((?!_next/static|_next/image|favicon.ico|logo.png|logo-\\d+.png|sw\\.js|manifest\\.webmanifest|.*\\.svg).*)",
  ],
};
