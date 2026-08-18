import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
// Imported rather than re-declared, per the single-home rule this constant
// documents. It has no dependencies, so it is safe to pull into the config.
import { SITE_URL } from "./src/lib/marketing/site-url";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Baseline HTTP security headers applied to every response. These are the
// unambiguously-safe set that does not risk breaking the app's inline
// scripts/styles or third-party integrations (Stripe, Supabase, Vercel):
//   - HSTS: force HTTPS for 2 years incl. subdomains (preload-eligible).
//   - X-Content-Type-Options: stop MIME sniffing.
//   - X-Frame-Options + CSP frame-ancestors: block clickjacking (no framing).
//   - Referrer-Policy: don't leak full URLs cross-origin.
//   - Permissions-Policy: deny powerful browser features the dashboard never uses.
//   - CSP base-uri/object-src: neutralize <base> hijack and legacy plugin embeds.
// A full script/style CSP is intentionally deferred to a separately tuned,
// browser-tested rollout (it requires per-integration allowlisting and a
// Report-Only bake to avoid breaking Stripe Checkout / Supabase auth).
// The STRICT policy we would like to enforce, shipped Report-Only so it
// changes nothing for users while telling us exactly what stands in the way.
//
// It is strict ON PURPOSE, in particular `script-src 'self'` with no
// `unsafe-inline`. Production currently serves ~18 inline <script> blocks (the
// Next hydration payload) with no nonce, so this WILL report on every page
// view. That is the measurement: a report-only policy that already allowed
// `unsafe-inline` would report nothing and teach us nothing.
//
// Enforcing it needs per-request nonces, which Next threads through its own
// inline scripts only for dynamically rendered routes. The marketing pages are
// `force-static` on purpose, so nonces there would trade away static
// generation. That trade is a separate decision, and this header exists to
// price it rather than to pre-empt it.
//
// Reports go to a hard-capped sink (`/api/security/csp-report`) that never
// touches the database. See that route for the cost reasoning.
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.nango.dev",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "report-uri /api/security/csp-report"
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  // Overrides the `Access-Control-Allow-Origin: *` that the hosting platform
  // adds to statically served assets. We never set that header in application
  // code, but it was going out on /robots.txt, /llms.txt and files under
  // public/ (verified in production), which a scanner reads as a wildcard CORS
  // misconfiguration.
  //
  // Naming our own origin rather than removing the header, because a headers()
  // rule can set a value but cannot delete one. The practical effect is the
  // same as having no header: a cross-origin browser read is refused either
  // way. Nothing depends on the wildcard, since no authenticated surface
  // returns this header at all and `Access-Control-Allow-Credentials` is never
  // sent anywhere.
  //
  // Crawlers are unaffected: CORS is a browser policy, and server-side
  // fetchers (which is what reads robots.txt and llms.txt) ignore it entirely.
  { key: "Access-Control-Allow-Origin", value: SITE_URL }
];

// /widget/frame is the ONE page that must be embeddable in an <iframe> on
// OTHER sites (the website chat widget). Browsers enforce the INTERSECTION
// of every CSP header on a response, so the global `frame-ancestors 'none'`
// above would override the per-tenant frame-ancestors the frame route sets
// dynamically (from chat_widget_settings.allowed_origins) no matter what we
// add, the global rule's matcher must EXCLUDE the path entirely. Everything
// else from the baseline set that doesn't block framing is re-applied here.
const widgetFrameHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  // No frame-ancestors here: the route handler emits it per tenant. The
  // widget is a public embed, keep it out of search results.
  { key: "X-Robots-Tag", value: "noindex" }
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: projectRoot
  },
  // `ssh2` pulls in native/optional deps (e.g. `cpu-features`) and ships a
  // `crypto.js` file that Turbopack cannot statically analyse for ESM. It must
  // stay as a runtime `require()` on the server, it is only reached from
  // server-only routes (orchestrator / provisioning), never from the browser.
  serverExternalPackages: ["ssh2"],
  // `/api/brand-logo` reads public/logo.png with a path built at runtime, which
  // the bundler cannot trace on its own, so the file would be missing from the
  // deployed function. Force it in.
  outputFileTracingIncludes: {
    "/api/brand-logo": ["./public/logo.png"]
  },
  async rewrites() {
    return {
      // beforeFiles runs ahead of the static-file lookup, which is the whole
      // point: it lets /logo.png be answered by a Next route while the actual
      // file stays in public/ for the build-time OG card to read.
      //
      // Without this, the platform serves public/logo.png directly and
      // replaces our Access-Control-Allow-Origin with `*` on any request
      // carrying an Origin header. That wildcard was the last open CASA
      // finding.
      beforeFiles: [{ source: "/logo.png", destination: "/api/brand-logo" }],
      afterFiles: [],
      fallback: []
    };
  },
  async redirects() {
    return [
      // OAuth callback forwarder for LEGACY Nango-brokered connections
      // (Google/Microsoft/Calendly, plus any Zoom link made before the
      // first-party Zoom OAuth shipped). Providers redirect to our domain so
      // only newcoworker.com ever appears in their consoles/verification
      // flows; Nango completes the token exchange. 308 preserves the method
      // and Next forwards the query string (code, state) automatically.
      {
        source: "/oauth-callback",
        destination: "https://api.nango.dev/oauth/callback",
        permanent: true
      }
    ];
  },
  async headers() {
    return [
      // Negative lookahead: every path EXCEPT /widget/frame gets the
      // full baseline (incl. the no-framing pair). See widgetFrameHeaders.
      { source: "/((?!widget/frame).*)", headers: securityHeaders },
      { source: "/widget/frame", headers: widgetFrameHeaders }
    ];
  }
};

export default withNextIntl(nextConfig);
