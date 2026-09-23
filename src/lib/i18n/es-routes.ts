/**
 * Public /es/... SEO mirrors for marketing pages. A Spanish URL rewrites to
 * the unprefixed route and pins the NEXT_LOCALE cookie to "es". English URLs
 * stay unprefixed (localePrefix: 'as-needed'). Each locale's HTML canonical
 * is itself; English is x-default. Legal pages are the exception: they keep
 * an English canonical even on /es/... and are omitted from the sitemap.
 */

import type { AppLocale } from "@/i18n/routing";

const ES_PREFIX = "/es";

/** Marketing paths that get a public /es/... mirror. */
export const SPANISH_MARKETING_PREFIXES = [
  "/",
  "/blog",
  "/features",
  "/pricing",
  "/integrations",
  "/industries",
  "/compare",
  "/faq",
  "/about",
  "/after-hours-answering",
  "/contact",
  "/terms",
  "/privacy",
  "/security",
  "/login",
  "/onboard",
  "/signup",
  "/ai-receptionist",
  "/ai-answering-service",
  "/after-hours-answering"
];

/**
 * True when the path (with or without the /es prefix) has a public /es/...
 * mirror. This is the single source of truth for "which paths are mirrored":
 * the proxy rewrite, the sitemap, hreflang alternates, and the language
 * switcher all match against it.
 */
export function isMirroredMarketingPath(pathname: string): boolean {
  const stripped = stripSpanishPrefix(pathname);
  return SPANISH_MARKETING_PREFIXES.some(
    (p) => stripped === p || (p !== "/" && stripped.startsWith(`${p}/`))
  );
}

export function isSpanishMarketingPath(pathname: string): boolean {
  if (pathname !== ES_PREFIX && !pathname.startsWith(`${ES_PREFIX}/`)) return false;
  return isMirroredMarketingPath(pathname);
}

/**
 * Binding legal text stays English. /es/terms and /es/privacy still exist as
 * human notices, but they must not be advertised as a second indexed URL.
 */
function isEnglishOnlySitemapPath(path: string): boolean {
  return path === "/terms" || path === "/privacy" || path.startsWith("/privacy/");
}

/**
 * `Metadata.alternates` for a mirrored marketing path. `path` is the
 * unprefixed route, e.g. "/pricing" or "/". `locale` selects which URL is
 * this page's canonical. English remains x-default. Legal pages pass "en"
 * even when the request is /es/... .
 */
export function esAlternates(
  path: string,
  locale: AppLocale = "en"
): {
  canonical: string;
  languages: { en: string; es: string; "x-default": string };
} {
  const languages = {
    en: path,
    es: path === "/" ? ES_PREFIX : `${ES_PREFIX}${path}`,
    "x-default": path
  };
  return {
    canonical: locale === "es" ? languages.es : languages.en,
    languages
  };
}

/**
 * Paths the sitemap should emit for one route. Legal pages and explicit
 * enOnly rows emit the English URL only.
 */
export function sitemapPathsFor(path: string, enOnly?: boolean): string[] {
  if (enOnly || isEnglishOnlySitemapPath(path) || !isMirroredMarketingPath(path)) {
    return [path];
  }
  const { languages } = esAlternates(path);
  return [languages.en, languages.es];
}

export function stripSpanishPrefix(pathname: string): string {
  if (pathname === ES_PREFIX) return "/";
  if (pathname.startsWith(`${ES_PREFIX}/`)) {
    // Always non-empty: "/es/..." leaves at least "/".
    return pathname.slice(ES_PREFIX.length);
  }
  return pathname;
}

/**
 * Prefix a marketing href with /es when the UI locale is Spanish.
 *
 * hreflang and the sitemap already advertise the /es twin; the header,
 * footer, and primary CTAs have to actually point there or a visitor on
 * /es is sent back to English. Non-mirrored paths (/dashboard, /docs/...)
 * and non-path hrefs (tel:, mailto:, https://) stay as written. English
 * stays unprefixed.
 */
export function localizedMarketingHref(href: string, locale: AppLocale): string {
  if (locale !== "es") return href;
  if (!href.startsWith("/") || href.startsWith("//")) return href;

  const splitAt = href.search(/[?#]/);
  const pathname = splitAt === -1 ? href : href.slice(0, splitAt);
  const rest = splitAt === -1 ? "" : href.slice(splitAt);

  if (pathname === ES_PREFIX || pathname.startsWith(`${ES_PREFIX}/`)) {
    return href;
  }
  if (!isMirroredMarketingPath(pathname)) return href;
  const prefixed = pathname === "/" ? ES_PREFIX : `${ES_PREFIX}${pathname}`;
  return `${prefixed}${rest}`;
}
