/**
 * Public sitemap builder.
 *
 * A hung or failing blog read must not 500 /sitemap.xml: crawlers treat a
 * 500 as "try later" and Search Console flags it. This module always returns
 * the static marketing URLs, and the route handler always serializes them as
 * HTTP 200 XML.
 *
 * Homepage loc uses siteUrl("/"), which is SITE_URL with no trailing slash,
 * matching the homepage canonical. Concatenating SITE_URL + "/" advertised a
 * second URL that also 200s.
 */

import { SEO_PILLAR_PATHS } from "@/lib/i18n/es-routes";
import { sitemapEntriesFor } from "./sitemap-entries";

/** Give the blog query this long, then ship the static sitemap without it. */
const SITEMAP_BLOG_TIMEOUT_MS = 2500;

type SitemapChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

type SitemapEntry = {
  url: string;
  changeFrequency: SitemapChangeFrequency;
  priority: number;
  alternates?: { languages: Record<string, string> };
};

type SitemapPost = { slug?: unknown };

type BuildSitemapOptions = {
  listPosts?: () => Promise<SitemapPost[]>;
  industrySlugs?: string[];
  compareSlugs?: string[];
  timeoutMs?: number;
};

type SitemapRoute = { path: string; priority: number; enOnly?: boolean };

const BLOG_SITEMAP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isUsableBlogSlug(slug: unknown): slug is string {
  return typeof slug === "string" && BLOG_SITEMAP_SLUG.test(slug);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sitemap_blog_timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

const STATIC_ROUTES: SitemapRoute[] = [
  { path: "/", priority: 1 },
  { path: "/pricing", priority: 0.9 },
  { path: "/features", priority: 0.8 },
  { path: "/integrations", priority: 0.8 },
  { path: "/integrations/zoom", priority: 0.6 },
  { path: "/integrations/slack", priority: 0.6 },
  { path: "/integrations/chatgpt", priority: 0.6 },
  { path: "/docs", priority: 0.5, enOnly: true },
  { path: "/docs/api", priority: 0.6 },
  { path: "/docs/push-notifications", priority: 0.6, enOnly: true },
  { path: "/security", priority: 0.5 },
  { path: "/security/vulnerability-disclosure", priority: 0.3, enOnly: true },
  { path: "/compare", priority: 0.8 },
  { path: "/industries", priority: 0.7 },
  { path: "/blog", priority: 0.8 },
  { path: "/faq", priority: 0.6 },
  { path: "/about", priority: 0.5 },
  { path: "/contact", priority: 0.5 },
  { path: "/onboard", priority: 0.9 },
  // Buyer-intent landings. Listed even if the pages merge later so Search
  // Console has the URLs either way. Product name stays "AI coworker".
  ...SEO_PILLAR_PATHS.map((path) => ({ path, priority: 0.9 })),
  { path: "/terms", priority: 0.2, enOnly: true },
  { path: "/privacy", priority: 0.2, enOnly: true }
];

function languagesRecord(languages: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [language, href] of Object.entries(languages)) {
    if (typeof href === "string" && href.length > 0) out[language] = href;
  }
  return out;
}

function entriesFor(route: SitemapRoute): SitemapEntry[] {
  // #1889: loc and hreflang go through siteUrl via sitemapEntriesFor, never
  // SITE_URL concatenated onto "/".
  return sitemapEntriesFor(route).map((entry) => {
    const languages = entry.alternates?.languages;
    const mapped: SitemapEntry = {
      url: entry.url,
      changeFrequency: (entry.changeFrequency ?? "weekly") as SitemapChangeFrequency,
      priority: entry.priority ?? route.priority
    };
    if (languages) {
      mapped.alternates = { languages: languagesRecord(languages) };
    }
    return mapped;
  });
}

function staticRouteEntries(): SitemapEntry[] {
  return STATIC_ROUTES.flatMap(entriesFor);
}

function catalogRoutes(industrySlugs: string[], compareSlugs: string[]): SitemapRoute[] {
  return [
    ...industrySlugs.map((slug) => ({ path: `/industries/${slug}`, priority: 0.7 })),
    ...compareSlugs.map((slug) => ({ path: `/compare/${slug}`, priority: 0.7 }))
  ];
}

async function loadBlogRoutes(
  listPosts: () => Promise<SitemapPost[]>,
  timeoutMs: number
): Promise<SitemapRoute[]> {
  try {
    const posts = await withTimeout(Promise.resolve().then(() => listPosts()), timeoutMs);
    if (!Array.isArray(posts)) return [];
    return posts
      .filter((p) => isUsableBlogSlug(p?.slug))
      .map((p) => ({ path: `/blog/${p.slug as string}`, priority: 0.6 }));
  } catch {
    return [];
  }
}

export async function buildSitemap(opts: BuildSitemapOptions = {}): Promise<SitemapEntry[]> {
  try {
    const industrySlugs = opts.industrySlugs ?? [];
    const compareSlugs = opts.compareSlugs ?? [];
    const listPosts = opts.listPosts ?? (async () => []);
    const timeoutMs = opts.timeoutMs ?? SITEMAP_BLOG_TIMEOUT_MS;
    const blogRoutes = await loadBlogRoutes(listPosts, timeoutMs);
    return [...STATIC_ROUTES, ...catalogRoutes(industrySlugs, compareSlugs), ...blogRoutes].flatMap(
      entriesFor
    );
  } catch {
    return staticRouteEntries();
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderSitemapXml(entries: SitemapEntry[]): string {
  const list = Array.isArray(entries) ? entries : [];
  const usable = list.filter((item) => typeof item?.url === "string" && item.url.length > 0);
  const hasAlternates = usable.some((item) => {
    const languages = item.alternates?.languages;
    return Boolean(languages && Object.keys(languages).length > 0);
  });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    hasAlternates
      ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
      : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  ];
  for (const item of usable) {
    lines.push("<url>");
    lines.push(`<loc>${escapeXml(item.url)}</loc>`);
    const languages = item.alternates?.languages;
    if (languages) {
      for (const language of Object.keys(languages)) {
        const href = languages[language];
        if (!href) continue;
        lines.push(
          `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(href)}" />`
        );
      }
    }
    lines.push(`<changefreq>${item.changeFrequency}</changefreq>`);
    lines.push(`<priority>${item.priority}</priority>`);
    lines.push("</url>");
  }
  lines.push("</urlset>");
  return lines.join("\n");
}
