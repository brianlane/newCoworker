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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
