import type { MetadataRoute } from "next";
import { INDUSTRIES } from "./(marketing)/industries/data";
import { COMPARISONS } from "./(marketing)/compare/data";
import { listPublishedPosts } from "@/lib/blog/db";
import { esAlternates, isMirroredMarketingPath } from "@/lib/i18n/es-routes";
import { SITE_URL } from "@/lib/marketing/site-url";

/**
 * Sitemap entries for one route. A path with a public /es/... mirror emits
 * two URLs (English plus the /es twin), both carrying hreflang alternates so
 * crawlers pair them; the mirror ranks a notch below the English canonical.
 * Non-mirrored paths (e.g. /docs/api, English-only by design) emit one.
 */
function entriesFor(route: { path: string; priority: number }): MetadataRoute.Sitemap {
  const base = { changeFrequency: "weekly" as const };
  if (!isMirroredMarketingPath(route.path)) {
    return [{ ...base, url: `${SITE_URL}${route.path}`, priority: route.priority }];
  }
  const { languages } = esAlternates(route.path);
  const alternates = {
    languages: { en: `${SITE_URL}${languages.en}`, es: `${SITE_URL}${languages.es}` }
  };
  return [
    { ...base, url: `${SITE_URL}${languages.en}`, priority: route.priority, alternates },
    {
      ...base,
      url: `${SITE_URL}${languages.es}`,
      priority: Math.max(0.1, Math.round((route.priority - 0.1) * 10) / 10),
      alternates
    }
  ];
}

// Rendered per request so published blog posts appear without a redeploy
// (and the CI build, which has mock Supabase env, never touches the DB).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: { path: string; priority: number }[] = [
    { path: "/", priority: 1 },
    { path: "/pricing", priority: 0.9 },
    { path: "/features", priority: 0.8 },
    { path: "/integrations", priority: 0.8 },
    { path: "/integrations/zoom", priority: 0.6 },
    { path: "/integrations/slack", priority: 0.6 },
    { path: "/integrations/chatgpt", priority: 0.6 },
    { path: "/docs/api", priority: 0.6 },
    { path: "/security", priority: 0.5 },
    { path: "/security/vulnerability-disclosure", priority: 0.3 },
    { path: "/compare", priority: 0.8 },
    { path: "/industries", priority: 0.7 },
    { path: "/blog", priority: 0.8 },
    { path: "/faq", priority: 0.6 },
    { path: "/about", priority: 0.5 },
    { path: "/contact", priority: 0.5 },
    { path: "/onboard", priority: 0.9 },
    { path: "/terms", priority: 0.2 },
    { path: "/privacy", priority: 0.2 }
  ];

  const industryRoutes = INDUSTRIES.map((i) => ({
    path: `/industries/${i.slug}`,
    priority: 0.7
  }));

  // Comparison pages punch above their weight in AI answers, where "X vs Y"
  // is one of the most common buyer questions.
  const compareRoutes = COMPARISONS.map((c) => ({
    path: `/compare/${c.slug}`,
    priority: 0.7
  }));

  // Published blog posts, best-effort: a DB hiccup must not 500 the
  // sitemap, so the static routes always render.
  let blogRoutes: { path: string; priority: number }[] = [];
  try {
    const posts = await listPublishedPosts({ limit: 500, offset: 0 });
    blogRoutes = posts.map((p) => ({ path: `/blog/${p.slug}`, priority: 0.6 }));
  } catch {
    blogRoutes = [];
  }

  return [...staticRoutes, ...industryRoutes, ...compareRoutes, ...blogRoutes].flatMap(
    entriesFor
  );
}
