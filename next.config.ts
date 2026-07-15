import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

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
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" }
];

// /widget/frame is the ONE page that must be embeddable in an <iframe> on
// OTHER sites (the website chat widget). Browsers enforce the INTERSECTION
// of every CSP header on a response, so the global `frame-ancestors 'none'`
// above would override the per-tenant frame-ancestors the frame route sets
// dynamically (from chat_widget_settings.allowed_origins) no matter what we
// add — the global rule's matcher must EXCLUDE the path entirely. Everything
// else from the baseline set that doesn't block framing is re-applied here.
const widgetFrameHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  // No frame-ancestors here: the route handler emits it per tenant. The
  // widget is a public embed — keep it out of search results.
  { key: "X-Robots-Tag", value: "noindex" }
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: projectRoot
  },
  // `ssh2` pulls in native/optional deps (e.g. `cpu-features`) and ships a
  // `crypto.js` file that Turbopack cannot statically analyse for ESM. It must
  // stay as a runtime `require()` on the server — it is only reached from
  // server-only routes (orchestrator / provisioning), never from the browser.
  serverExternalPackages: ["ssh2"],
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

export default nextConfig;
