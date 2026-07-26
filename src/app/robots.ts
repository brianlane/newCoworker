import type { MetadataRoute } from "next";
import { AI_CRAWLER_TOKENS } from "@/lib/marketing/ai-crawlers";

// Authenticated/admin surfaces and API routes are not for crawlers.
const DISALLOW = ["/dashboard", "/admin", "/api"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      // AI assistants get their own group. A crawler that matches a specific
      // group ignores `*` entirely, so the disallows are repeated rather than
      // inherited. Being explicit is the point: buyers increasingly ask an
      // assistant instead of searching, and a future tightening of `*` must
      // not silently take us out of those answers.
      { userAgent: AI_CRAWLER_TOKENS, allow: "/", disallow: DISALLOW }
    ],
    sitemap: "https://newcoworker.com/sitemap.xml"
  };
}
