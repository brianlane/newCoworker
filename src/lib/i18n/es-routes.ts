/**
 * Public /es/... SEO mirrors for marketing pages. A Spanish URL rewrites to
 * the unprefixed route and pins the NEXT_LOCALE cookie to "es", English URLs
 * stay canonical and untouched (localePrefix: 'as-needed').
 */

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
  "/contact",
  "/terms",
  "/privacy",
  "/security",
  "/login",
  "/onboard",
  "/signup"
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
 * `Metadata.alternates` for a mirrored marketing path: the English URL stays
 * canonical (and x-default), the /es mirror is the Spanish alternate. `path`
 * is the unprefixed route path, e.g. "/pricing" or "/".
 */
export function esAlternates(path: string): {
  canonical: string;
  languages: { en: string; es: string; "x-default": string };
} {
  return {
    canonical: path,
    languages: {
      en: path,
      es: path === "/" ? ES_PREFIX : `${ES_PREFIX}${path}`,
      "x-default": path
    }
  };
}

export function stripSpanishPrefix(pathname: string): string {
  if (pathname === ES_PREFIX) return "/";
  if (pathname.startsWith(`${ES_PREFIX}/`)) {
    // Always non-empty: "/es/..." leaves at least "/".
    return pathname.slice(ES_PREFIX.length);
  }
  return pathname;
}
