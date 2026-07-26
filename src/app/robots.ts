import type { MetadataRoute } from "next";
import { AI_ANSWER_CRAWLER_TOKENS } from "@/lib/marketing/ai-crawlers";

// Authenticated/admin surfaces and API routes are not for crawlers.
const DISALLOW = ["/dashboard", "/admin", "/api"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      // The answer engines get their own group. A crawler that matches a
      // specific group ignores `*` entirely, so the disallows are repeated
      // rather than inherited. Being explicit is the point: buyers
      // increasingly ask an assistant instead of searching, and a future
      // tightening of `*` must not silently take us out of those answers.
      //
      // Training crawlers are deliberately absent (see
      // AI_ANSWER_CRAWLER_TOKENS): this zone's Cloudflare managed block
      // disallows them, and emitting a contradicting allow here would make
      // the served file's meaning parser-dependent.
      { userAgent: AI_ANSWER_CRAWLER_TOKENS, allow: "/", disallow: DISALLOW }
    ],
    sitemap: "https://newcoworker.com/sitemap.xml"
  };
}
