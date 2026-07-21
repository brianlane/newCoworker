import type { MetadataRoute } from "next";
import { INDUSTRIES } from "./industries/data";
import { listPublishedPosts } from "@/lib/blog/db";

const BASE_URL = "https://newcoworker.com";

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
    { path: "/compare/gohighlevel", priority: 0.7 },
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

  // Published blog posts — best-effort: a DB hiccup must not 500 the
  // sitemap, so the static routes always render.
  let blogRoutes: { path: string; priority: number }[] = [];
  try {
    const posts = await listPublishedPosts({ limit: 500, offset: 0 });
    blogRoutes = posts.map((p) => ({ path: `/blog/${p.slug}`, priority: 0.6 }));
  } catch {
    blogRoutes = [];
  }

  return [...staticRoutes, ...industryRoutes, ...blogRoutes].map((r) => ({
    url: `${BASE_URL}${r.path}`,
    changeFrequency: "weekly" as const,
    priority: r.priority
  }));
}
