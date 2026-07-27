import { describe, expect, it } from "vitest";
import {
  MACHINE_PATHS,
  deployTouchesPublicPages,
  deployUrlSet,
  parseSitemapUrls
} from "@/lib/marketing/indexnow-deploy";

describe("deployTouchesPublicPages", () => {
  it("trips on marketing pages and the code they share", () => {
    for (const path of [
      "src/app/page.tsx",
      "src/app/pricing/page.tsx",
      "src/app/compare/zinng/page.tsx",
      "src/app/industries/[slug]/page.tsx",
      "src/components/marketing/MarketingFooter.tsx",
      "src/lib/marketing/llms-content.ts",
      "src/lib/blog/publish.ts",
      "src/lib/plans/tier.ts",
      "messages/en.json",
      "messages/es.json"
    ]) {
      expect(deployTouchesPublicPages([path]), path).toBe(true);
    }
  });

  it("does not trip on the sections robots.txt already disallows", () => {
    // Pinging because a dashboard route changed would announce a recrawl of
    // pages that did not change, which is the behavior the protocol asks us
    // not to have.
    for (const path of [
      "src/app/dashboard/bookings/page.tsx",
      "src/app/admin/(protected)/ai-search/page.tsx",
      "src/app/api/internal/blog-publish-sweep/route.ts",
      "src/app/oauth/consent/page.tsx"
    ]) {
      expect(deployTouchesPublicPages([path]), path).toBe(false);
    }
  });

  it("sees through a route group to the real section name", () => {
    // `(protected)` is not a URL segment, so the section that decides this is
    // `admin`, not the parenthesised group.
    expect(deployTouchesPublicPages(["src/app/(protected)/admin/x/page.tsx"])).toBe(false);
    expect(deployTouchesPublicPages(["src/app/(marketing)/pricing/page.tsx"])).toBe(true);
  });

  it("treats a path that is nothing but a route group as public", () => {
    // No real section to judge, so it falls through to the prefix check.
    // Public is the right default: the only thing under src/app with no
    // section is shared chrome, which renders on marketing pages.
    expect(deployTouchesPublicPages(["src/app/(marketing)"])).toBe(true);
  });

  it("does not trip on backend, infra, test, or doc changes", () => {
    for (const path of [
      "supabase/migrations/20260821181520_ai_traffic_events.sql",
      "vps/chat-worker/worker.mjs",
      "tests/indexnow.test.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "src/lib/db/businesses.ts",
      "package-lock.json"
    ]) {
      expect(deployTouchesPublicPages([path]), path).toBe(false);
    }
  });

  it("trips when any one file in a mixed diff is public", () => {
    expect(
      deployTouchesPublicPages([
        "src/lib/db/businesses.ts",
        "supabase/migrations/x.sql",
        "src/app/faq/page.tsx"
      ])
    ).toBe(true);
  });

  it("is false for an empty or blank list, so the caller fails closed", () => {
    expect(deployTouchesPublicPages([])).toBe(false);
    expect(deployTouchesPublicPages(["", "   "])).toBe(false);
  });

  it("tolerates surrounding whitespace from a piped file list", () => {
    expect(deployTouchesPublicPages(["  src/app/pricing/page.tsx  "])).toBe(true);
  });
});

describe("parseSitemapUrls", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.newcoworker.com/</loc><priority>1</priority></url>
<url><loc>https://www.newcoworker.com/pricing</loc></url>
<url><loc>  https://www.newcoworker.com/faq  </loc></url>
</urlset>`;

  it("pulls every absolute loc, trimmed", () => {
    expect(parseSitemapUrls(xml)).toEqual([
      "https://www.newcoworker.com/",
      "https://www.newcoworker.com/pricing",
      "https://www.newcoworker.com/faq"
    ]);
  });

  it("drops duplicates so the reported count is honest", () => {
    expect(parseSitemapUrls("<loc>https://a.test/x</loc><loc>https://a.test/x</loc>")).toEqual([
      "https://a.test/x"
    ]);
  });

  it("ignores relative and junk entries rather than submitting them", () => {
    expect(parseSitemapUrls("<loc>/pricing</loc><loc>ftp://a.test/x</loc>")).toEqual([]);
  });

  it("returns what parsed from a truncated document instead of throwing", () => {
    expect(parseSitemapUrls("<url><loc>https://a.test/x</loc></url><url><loc>https://")).toEqual([
      "https://a.test/x"
    ]);
  });

  it("returns nothing for empty or non-sitemap input", () => {
    expect(parseSitemapUrls("")).toEqual([]);
    expect(parseSitemapUrls("<html><body>404</body></html>")).toEqual([]);
  });
});

describe("deployUrlSet", () => {
  const xml = "<loc>https://www.newcoworker.com/pricing</loc>";

  it("adds the machine surfaces the sitemap never lists", () => {
    const urls = deployUrlSet(xml, "https://www.newcoworker.com");
    expect(urls).toContain("https://www.newcoworker.com/pricing");
    for (const path of MACHINE_PATHS) {
      expect(urls).toContain(`https://www.newcoworker.com${path}`);
    }
  });

  it("tolerates a trailing slash on the origin without doubling it", () => {
    expect(deployUrlSet("", "https://www.newcoworker.com/")).toEqual(
      MACHINE_PATHS.map((p) => `https://www.newcoworker.com${p}`)
    );
  });

  it("does not list a machine surface twice when the sitemap already has it", () => {
    const urls = deployUrlSet(
      "<loc>https://www.newcoworker.com/sitemap.xml</loc>",
      "https://www.newcoworker.com"
    );
    expect(urls.filter((u) => u.endsWith("/sitemap.xml"))).toHaveLength(1);
  });
});
