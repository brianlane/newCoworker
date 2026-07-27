/**
 * The one canonical origin for public URLs.
 *
 * **www, not the apex.** The apex 307-redirects every path to www, so the
 * apex was never the host that actually serves anything, yet canonical tags,
 * og:url, the sitemap, and JSON-LD all declared it. That told crawlers to
 * index a set of URLs that all redirect, and it put the authoritative
 * robots.txt on a hostname whose robots.txt we do not fully control.
 *
 * Lives here, alone, because this string was previously copy-pasted into six
 * files (layout, sitemap, robots, home, industries, compare) and a host
 * change had to be made six times to stay consistent. Import it; never
 * re-declare it. `tests/site-url.test.ts` fails the build if a hardcoded
 * newcoworker.com origin reappears in src/.
 */
export const SITE_URL = "https://www.newcoworker.com";

/** Absolute public URL for a root-relative path. */
export function siteUrl(path: string): string {
  return path === "/" ? SITE_URL : `${SITE_URL}${path}`;
}
