import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Serves the brand logo for the public `/logo.png` URL, which is rewritten
 * here in `next.config.ts`.
 *
 * Why a route handler instead of just letting `public/logo.png` be served
 * directly: the hosting platform's static-asset serving replaces our
 * `Access-Control-Allow-Origin` with `*` whenever the request carries an
 * `Origin` header. That wildcard is the CASA "Cross-Domain Misconfiguration"
 * finding. A response Next itself produces keeps our header, which is also why
 * `/_next/image` was already unaffected (verified in production: the optimizer
 * returns our origin, raw `public/` serving returns `*`).
 *
 * The file deliberately stays in `public/`, because
 * `src/app/opengraph-image.tsx` reads it from disk at build time to inline the
 * OG card. Moving it would break that. `next.config.ts` force-includes it in
 * this route's bundle via `outputFileTracingIncludes`, since a path built with
 * `path.join` cannot be traced automatically.
 *
 * Traffic here is small: every `next/image` usage resolves through
 * `/_next/image` instead, so only the raw `src="/logo.png"` references (error
 * and not-found pages, the OAuth consent screen) and the JSON-LD `logo` URL
 * land on this route.
 */

export const dynamic = "force-dynamic";

// Read once per instance rather than per request. The file ships with the
// bundle and never changes between deploys.
const LOGO = readFileSync(path.join(process.cwd(), "public", "logo.png"));

export function GET(): Response {
  return new Response(new Uint8Array(LOGO), {
    headers: {
      "content-type": "image/png",
      // Long-lived: the bytes only change on deploy, and this URL is embedded
      // in JSON-LD and error pages where a stale logo is harmless.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
