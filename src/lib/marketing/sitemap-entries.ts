/**
 * Absolute sitemap `<loc>` and xhtml hreflang URLs.
 *
 * Built through `siteUrl`, not `${SITE_URL}${path}`. Concatenating the origin
 * onto `"/"` yields a trailing slash on the origin that
 * disagrees with the HTML canonical Next emits for home: `resolveAbsoluteUrlWithPathname`
 * uses `URL.origin` when pathname is `/` and `trailingSlash` is unset
 * (false in next.config), so the canonical is the origin with no slash.
 * Google treats those two strings as different URLs even though HTTP fetches
 * the same `/`. `tests/homepage-url-consistency.test.ts` holds the three
 * surfaces (canonical, sitemap loc, hreflang) to one form.
 *
 * New sitemap routes should keep calling this helper so they inherit the
 * same slash policy. Do not go back to string-concatenating SITE_URL.
 */

import type { MetadataRoute } from "next";
import { esAlternates, sitemapPathsFor } from "@/lib/i18n/es-routes";
import { siteUrl } from "./site-url";

type SitemapRoute = {
  path: string;
  priority: number;
  /** English-only page under a mirrored prefix (prefix matching would
   *  otherwise claim it): emit one URL, no /es twin, no hreflang pair. */
  enOnly?: boolean;
};

/**
 * Sitemap entries for one route. A path with a public /es/... mirror emits
 * two URLs (English plus the /es twin), both carrying hreflang alternates so
 * crawlers pair them; the mirror ranks a notch below English. Legal pages
 * and other enOnly paths emit the English URL only: the /es notice exists
 * for humans, but its canonical is English, so advertising it here is what
 * produced the Search Console "alternate page with proper canonical" emails.
 */
export function sitemapEntriesFor(route: SitemapRoute): MetadataRoute.Sitemap {
  const base = { changeFrequency: "weekly" as const };
  const paths = sitemapPathsFor(route.path, route.enOnly);
  if (paths.length === 1) {
    return [{ ...base, url: siteUrl(paths[0]), priority: route.priority }];
  }
  const { languages } = esAlternates(route.path);
  const alternates = {
    languages: { en: siteUrl(languages.en), es: siteUrl(languages.es) }
  };
  return [
    { ...base, url: siteUrl(languages.en), priority: route.priority, alternates },
    {
      ...base,
      url: siteUrl(languages.es),
      priority: Math.max(0.1, Math.round((route.priority - 0.1) * 10) / 10),
      alternates
    }
  ];
}
