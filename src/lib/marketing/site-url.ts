/**
 * The one canonical origin for public URLs.
 *
 * **www, not the apex.** The apex 308-redirects every path to www, so the
 * apex was never the host that actually serves anything, yet canonical tags,
 * og:url, the sitemap, and JSON-LD all declared it. That told crawlers to
 * index a set of URLs that all redirect, and it put the authoritative
 * robots.txt on a hostname whose robots.txt we do not fully control.
 *
 * Lives here, alone, because this string was previously copy-pasted into six
 * files (layout, sitemap, robots, home, industries, compare) plus four inline
 * literals, so a host change was ten edits and any missed one drifted
 * quietly. The blog pages HAD already drifted to www while everything else
 * said apex, and nothing caught it. Import it; never re-declare it.
 * `tests/site-url.test.ts` fails the build if a hardcoded newcoworker.com
 * origin reappears in src/ outside a doc comment.
 *
 * Changing this host is not a rename: it moves every canonical tag, og:url,
 * sitemap entry, and the robots.txt Sitemap line. Re-run
 * `tsx debug/aeo-crawler-probe.ts` against both hosts afterward. See the
 * README, "Why the above drifted".
 */
export const SITE_URL = "https://www.newcoworker.com";

/** Absolute public URL for a root-relative path. */
export function siteUrl(path: string): string {
  return path === "/" ? SITE_URL : `${SITE_URL}${path}`;
}
