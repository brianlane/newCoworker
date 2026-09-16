---
name: gsc-es-canonical-self
description: "Sep 2026 GSC 'Alternate page with proper canonical' on /es URLs: marketing pages must self-canonical from x-pathname, not the NEXT_LOCALE cookie; legal /es twins stay English-canonical and off the sitemap"
metadata:
  node_type: memory
  type: project
  originSessionId: a5c156d2-a009-48bc-900b-dc57086314ad
  modified: 2026-09-16T22:30:00.000Z
---

On 2026-09-16 Search Console mailed "Alternate page with proper canonical tag"
for Spanish URLs, including a sitemap-specific one. The live example was
https://www.newcoworker.com/es/privacy (crawled Sep 7): the HTML canonical
pointed at English /privacy while sitemap.xml listed the /es twin. Indexed
count that day was 6; 107 "not indexed", of which this reason was 1. Do not
lump this with the Jul 30 apex/www emails (session d9d1e483: those 308s are
intentional, SITE_URL is www) or the Aug 403s (project_cloudflare_scraper_rules_block_googlebot:
Validate fix already Started; do not re-click).

The old `esAlternates(path)` always set canonical to the English URL. That
fought hreflang and the sitemap's 37 /es URLs. Cookie-based locale is also
wrong: a leftover NEXT_LOCALE=es on /pricing would tell Google the English
URL is a duplicate. Canonical must follow the requested URL.

Fix (es-self-canonical):

- `src/proxy.ts` /es rewrite forwards the original path as `x-pathname`
  (Next.js exposes it to the app as the request header, tests see
  `x-middleware-request-x-pathname`).
- Marketing `generateMetadata` uses `esAlternatesForRequest` in
  `src/lib/i18n/es-metadata.ts`, which reads `x-pathname` and ignores the
  cookie. `/es/pricing` self-canonicals; `/pricing` stays English even with
  a Spanish cookie.
- Binding legal pages (`/terms`, `/privacy`, `/privacy/data-deletion`) keep
  English canonical via static `esAlternates(path)` and are omitted from the
  sitemap as /es twins (`isEnglishOnlySitemapPath` / `enOnly: true`).
- Do not click GSC "Validate fix" on the canonical reason until this is live
  on www. IndexNow on the next main deploy will ping the new sitemap.

"Discovered, currently not indexed" (65 that day) is Google quota, not a
block. 404s dropping 115 to 16 was already healthy.
