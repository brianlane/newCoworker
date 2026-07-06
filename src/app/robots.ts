import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Authenticated/admin surfaces and API routes are not for crawlers.
        disallow: ["/dashboard", "/admin", "/api"]
      }
    ],
    sitemap: "https://newcoworker.com/sitemap.xml"
  };
}
