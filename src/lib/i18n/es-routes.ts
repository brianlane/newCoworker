/**
 * Public /es/... SEO mirrors for marketing pages. A Spanish URL rewrites to
 * the unprefixed route and pins the NEXT_LOCALE cookie to "es" — English URLs
 * stay canonical and untouched (localePrefix: 'as-needed').
 */

const ES_PREFIX = "/es";

/** Marketing paths that get a public /es/... mirror. */
const SPANISH_MARKETING_PREFIXES = [
  "/",
  "/blog",
  "/features",
  "/pricing",
  "/integrations",
  "/industries",
  "/faq",
  "/about",
  "/contact",
  "/terms",
  "/privacy",
  "/login",
  "/onboard",
  "/signup"
];

export function isSpanishMarketingPath(pathname: string): boolean {
  if (pathname !== ES_PREFIX && !pathname.startsWith(`${ES_PREFIX}/`)) return false;
  const stripped = stripSpanishPrefix(pathname);
  return SPANISH_MARKETING_PREFIXES.some(
    (p) => stripped === p || (p !== "/" && stripped.startsWith(`${p}/`))
  );
}

export function stripSpanishPrefix(pathname: string): string {
  if (pathname === ES_PREFIX) return "/";
  if (pathname.startsWith(`${ES_PREFIX}/`)) {
    // Always non-empty: "/es/..." leaves at least "/".
    return pathname.slice(ES_PREFIX.length);
  }
  return pathname;
}
