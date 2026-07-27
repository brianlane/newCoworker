/**
 * Deciding what to tell IndexNow after a production deploy.
 *
 * The pure half of `scripts/indexnow-submit.ts`: which URLs exist, and whether
 * this particular deploy is worth telling the engines about at all.
 *
 * Two deliberate choices, both of which the README's anti-drift rules argue
 * for:
 *
 *   1. **URLs come from the live sitemap, never a route table.** A hardcoded
 *      "this path changed, so ping that URL" map is the exact drift shape we
 *      keep hitting: a new marketing page would need a registry entry nobody
 *      remembers, and its absence would be silent. Reading `/sitemap.xml`
 *      means a new page registers itself the moment it ships.
 *   2. **The gate decides IF, not WHICH.** When a deploy touches public-page
 *      code we submit the whole set, because shared components and the shared
 *      copy catalogs genuinely can change any page. That is an honest claim
 *      rather than an over-submission, and at a couple of dozen URLs on a
 *      handful of deploys a week it is nowhere near the protocol's limits
 *      (10,000 URLs per request).
 */

/** Route sections whose code cannot change a public page. */
const NON_PUBLIC_APP_SECTIONS = ["dashboard", "admin", "api", "oauth"];

/**
 * Path prefixes that CAN change what a crawler sees. Broad on purpose: the
 * cost of an extra entry is one wasted recrawl, the cost of a missing one is
 * a page that silently never gets announced.
 */
const PUBLIC_PATH_PREFIXES = [
  "src/app/",
  "src/components/marketing/",
  "src/lib/marketing/",
  "src/lib/blog/",
  "src/lib/plans/"
];

/** Exact files that are public copy rather than a directory of it. */
const PUBLIC_EXACT_PATHS = ["messages/en.json", "messages/es.json"];

/**
 * Machine-facing surfaces that change with a deploy but are not sitemap
 * entries, so nothing else would ever announce them.
 */
export const MACHINE_PATHS = ["/sitemap.xml", "/llms.txt", "/llms-full.txt"];

/** True when this changed path lives under a non-public section of the app. */
function isNonPublicAppPath(path: string): boolean {
  if (!path.startsWith("src/app/")) return false;
  const rest = path.slice("src/app/".length);
  // Route groups like `(protected)` are not URL segments; the section that
  // matters is the first real directory name.
  const section = rest.split("/").find((part) => !part.startsWith("(")) ?? "";
  return NON_PUBLIC_APP_SECTIONS.includes(section);
}

/**
 * Should this deploy announce anything? True when at least one changed file
 * could alter a public page.
 *
 * The caller FAILS CLOSED on an empty or unavailable list: skipping a ping
 * costs a few days of latency (the weekly auto-post re-submits the sitemap
 * anyway), while pinging on every backend-only deploy is the rate-limit
 * courting behavior the protocol warns against.
 */
export function deployTouchesPublicPages(changedPaths: string[]): boolean {
  return changedPaths.some((raw) => {
    const path = raw.trim();
    if (path === "") return false;
    if (PUBLIC_EXACT_PATHS.includes(path)) return true;
    if (isNonPublicAppPath(path)) return false;
    return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  });
}

/**
 * Absolute `<loc>` URLs from a sitemap. Deliberately a regex rather than an
 * XML parser: the only thing needed is the loc list, and a malformed tail
 * should still yield the URLs that parsed rather than throwing away the run.
 */
export function parseSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = match[1].trim();
    // Relative or junk entries would be dropped by the submitter's same-host
    // filter anyway; drop them here so the reported count is honest.
    if (url.startsWith("http://") || url.startsWith("https://")) urls.push(url);
  }
  return [...new Set(urls)];
}

/** Sitemap URLs plus the machine surfaces, deduped, for one origin. */
export function deployUrlSet(sitemapXml: string, origin: string): string[] {
  const base = origin.replace(/\/$/, "");
  return [...new Set([...parseSitemapUrls(sitemapXml), ...MACHINE_PATHS.map((p) => `${base}${p}`)])];
}
