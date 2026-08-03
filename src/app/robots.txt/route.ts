import { buildRobotsTxt } from "@/lib/marketing/robots-txt";

// Dynamic, not static, and the reason is CORS rather than freshness. The
// policy is still compiled in and still changes only on deploy.
//
// Vercel serves a `force-static` route as a static asset, and its static
// serving replaces our `Access-Control-Allow-Origin` with `*` whenever the
// request carries an `Origin` header. Our header is applied and visible on a
// plain request, so the config is right; it loses only in the CORS case, which
// is precisely the case a scanner exercises. That wildcard is the open CASA
// finding (Cross-Domain Misconfiguration) this route change closes.
//
// Verified: the `force-dynamic` siblings `/llms-full.txt` and
// `/.well-known/security.txt` return our origin even with an `Origin` header,
// while the `force-static` `/robots.txt` returned `*`.
//
// The cost is a function invocation on a cache miss. It stays small because
// the response is cached for an hour with a day of stale-while-revalidate, and
// the Cloudflare edge caches it as well, so crawlers overwhelmingly hit cache
// rather than the origin.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(buildRobotsTxt(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
