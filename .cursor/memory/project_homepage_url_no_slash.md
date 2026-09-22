---
name: homepage-url-no-slash
description: "Homepage public URL is SITE_URL with no trailing slash. HTML canonical (Next URL.origin), sitemap loc, hreflang, JSON-LD, and llms Home all go through siteUrl('/'). Never concatenate SITE_URL + '/'."
metadata:
  node_type: memory
  type: project
  originSessionId: bc-6bcd833b-c093-5e02-ba60-74b86ef13613
  modified: 2026-09-22T22:40:00.000Z
---

The 2026-09-22 SEO audit found homepage canonical `SITE_URL` (no slash) and
sitemap loc `SITE_URL/` (slash). Both HTTP 200, because a request to the
origin always fetches `/`. Google still treats the two strings as different
URLs.

Pick no-slash. That is already SITE_URL, `siteUrl("/")`, JSON-LD `url`, and
what Next.js metadata emits: `resolveAbsoluteUrlWithPathname` uses
`URL.origin` when pathname is `/` and `trailingSlash` is unset (false in
next.config). The sitemap was the odd one out because it concatenated
`${SITE_URL}${path}` and path for home is `/`.

The producer is `sitemapEntriesFor` in `src/lib/marketing/sitemap-entries.ts`.
New sitemap routes (pillar pages, etc.) must call that helper so they inherit
the same slash policy. Do not go back to string-concatenating SITE_URL.
Internal Next `<Link href="/">` is the matching root-relative form.

Distinct from GSC /es self-canonical (project_gsc_es_canonical_self) and from
the apex/www 308s.
