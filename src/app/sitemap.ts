import type { MetadataRoute } from "next";
import { INDUSTRIES } from "./industries/data";

const BASE_URL = "https://newcoworker.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: { path: string; priority: number }[] = [
    { path: "/", priority: 1 },
    { path: "/pricing", priority: 0.9 },
    { path: "/features", priority: 0.8 },
    { path: "/integrations", priority: 0.8 },
    { path: "/industries", priority: 0.7 },
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

  return [...staticRoutes, ...industryRoutes].map((r) => ({
    url: `${BASE_URL}${r.path}`,
    changeFrequency: "weekly" as const,
    priority: r.priority
  }));
}
