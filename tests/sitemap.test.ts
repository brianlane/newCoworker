import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "@/app/(marketing)/industries/data";
import { COMPARISONS } from "@/app/(marketing)/compare/data";
import { GET } from "@/app/sitemap.xml/route";
import {
  SEO_PILLAR_PATHS,
  sitemapPathsFor,
  SPANISH_MARKETING_PREFIXES
} from "@/lib/i18n/es-routes";
import { parseSitemapUrls } from "@/lib/marketing/indexnow-deploy";
import { buildSitemap, renderSitemapXml } from "@/lib/marketing/sitemap";
import { SITE_URL, siteUrl } from "@/lib/marketing/site-url";

function locs(entries: Awaited<ReturnType<typeof buildSitemap>>): string[] {
  return entries.map((entry) => entry.url);
}

describe("homepage slash policy", () => {
  it("matches siteUrl('/') and the canonical origin: no trailing slash", async () => {
    // Homepage HTML canonical is SITE_URL (no slash). Concatenating
    // SITE_URL + "/" advertised a second URL that also 200s.
    expect(siteUrl("/")).toBe(SITE_URL);
    expect(SITE_URL.endsWith("/")).toBe(false);

    const entries = await buildSitemap();
    expect(locs(entries)).toContain(siteUrl("/"));
    expect(locs(entries)).not.toContain(`${SITE_URL}/`);
    expect(locs(entries).every((url) => !url.endsWith("/"))).toBe(true);
  });

  it("pairs the English homepage with /es, also without a trailing slash", async () => {
    const home = (await buildSitemap()).find((entry) => entry.url === siteUrl("/"));
    expect(home?.alternates?.languages).toEqual({
      en: siteUrl("/"),
      es: siteUrl("/es")
    });
  });
});

describe("buyer-intent pillar URLs", () => {
  it("lists the three landings the SEO audit named, plus /es mirrors", async () => {
    expect([...SEO_PILLAR_PATHS]).toEqual([
      "/ai-receptionist",
      "/ai-answering-service",
      "/after-hours-answering"
    ]);

    const urls = locs(await buildSitemap());
    for (const path of SEO_PILLAR_PATHS) {
      expect(SPANISH_MARKETING_PREFIXES).toContain(path);
      expect(sitemapPathsFor(path)).toEqual([path, `/es${path}`]);
      expect(urls).toContain(siteUrl(path));
      expect(urls).toContain(siteUrl(`/es${path}`));
    }
  });
});

describe("buildSitemap never 500s", () => {
  it("still returns the static routes when the blog read throws", async () => {
    const entries = await buildSitemap({
      listPosts: async () => {
        throw new Error("listPublishedPosts: connection refused");
      }
    });
    expect(locs(entries)).toContain(siteUrl("/"));
    expect(locs(entries)).toContain(siteUrl("/pricing"));
    expect(locs(entries).some((url) => url.includes("/blog/"))).toBe(false);
  });

  it("still returns the static routes when listPosts throws synchronously", async () => {
    const entries = await buildSitemap({
      listPosts: () => {
        throw new Error("sync boom");
      }
    });
    expect(locs(entries)).toContain(siteUrl("/"));
  });

  it("still returns the static routes when the blog read rejects a string", async () => {
    const entries = await buildSitemap({
      listPosts: () => Promise.reject("supabase blip")
    });
    expect(locs(entries)).toContain(siteUrl("/"));
  });

  it("abandons a hung blog list and still returns the static sitemap", async () => {
    const entries = await buildSitemap({
      listPosts: () => new Promise(() => {}),
      timeoutMs: 20
    });
    expect(locs(entries)).toContain(siteUrl("/"));
    expect(locs(entries)).toContain(siteUrl("/ai-receptionist"));
  });

  it("does not wait around for a post that arrives after the timeout", async () => {
    const entries = await buildSitemap({
      listPosts: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ slug: "late-post" }]), 40);
        }),
      timeoutMs: 10
    });
    expect(locs(entries)).not.toContain(siteUrl("/blog/late-post"));
  });

  it("skips unusable blog slugs rather than emitting broken locs", async () => {
    const entries = await buildSitemap({
      listPosts: async () => [
        { slug: "good-post" },
        { slug: "" },
        { slug: "has/slash" },
        { slug: "has space" },
        { slug: "amp&ersand" },
        { slug: "under_score" },
        { slug: 12 as unknown as string },
        null as unknown as { slug: string },
        { slug: "also-good" }
      ]
    });
    const urls = locs(entries);
    expect(urls).toContain(siteUrl("/blog/good-post"));
    expect(urls).toContain(siteUrl("/blog/also-good"));
    expect(urls).not.toContain(siteUrl("/blog/"));
    expect(urls.some((url) => url.includes("has/slash"))).toBe(false);
    expect(urls.some((url) => url.includes("has space"))).toBe(false);
    expect(urls.some((url) => url.includes("amp"))).toBe(false);
    expect(urls.some((url) => url.includes("under_score"))).toBe(false);
  });

  it("treats a non-array blog payload as no posts", async () => {
    const entries = await buildSitemap({
      listPosts: async () => ({ length: 1 } as unknown as { slug: string }[])
    });
    expect(locs(entries).some((url) => url.includes("/blog/"))).toBe(false);
  });

  it("falls back to static routes when the industry catalog cannot be mapped", async () => {
    const entries = await buildSitemap({
      industrySlugs: {
        map() {
          throw new Error("catalog boom");
        }
      } as unknown as string[]
    });
    expect(locs(entries)).toContain(siteUrl("/"));
    expect(locs(entries)).toContain(siteUrl("/pricing"));
    expect(locs(entries).some((url) => url.includes("/industries/"))).toBe(false);
  });

  it("includes the industry and compare slugs the route passes in", async () => {
    const entries = await buildSitemap({
      industrySlugs: ["home-services"],
      compareSlugs: ["smith-ai"],
      listPosts: async () => [{ slug: "shipped-this-week" }]
    });
    const urls = locs(entries);
    expect(urls).toContain(siteUrl("/industries/home-services"));
    expect(urls).toContain(siteUrl("/es/industries/home-services"));
    expect(urls).toContain(siteUrl("/compare/smith-ai"));
    expect(urls).toContain(siteUrl("/blog/shipped-this-week"));
    expect(urls).toContain(siteUrl("/es/blog/shipped-this-week"));
  });

  it("marks English-only legal and docs URLs without an /es twin", async () => {
    const urls = locs(await buildSitemap());
    expect(urls).toContain(siteUrl("/terms"));
    expect(urls).not.toContain(siteUrl("/es/terms"));
    expect(urls).toContain(siteUrl("/docs"));
    expect(urls).not.toContain(siteUrl("/es/docs"));
    const terms = (await buildSitemap()).find((entry) => entry.url === siteUrl("/terms"));
    expect(terms?.alternates).toBeUndefined();
  });
});

describe("renderSitemapXml", () => {
  it("emits a urlset crawlers can parse, escaping XML in loc and hreflang", () => {
    const raw = `${SITE_URL}/path?a=1&b=2<c>"d'e`;
    const xml = renderSitemapXml([
      {
        url: raw,
        changeFrequency: "weekly",
        priority: 0.5,
        alternates: {
          languages: {
            en: raw,
            es: `${SITE_URL}/es/path`
          }
        }
      }
    ]);
    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain("&amp;b=2&lt;c&gt;&quot;d&apos;e");
    expect(xml).not.toContain("?a=1&b=2");
    expect(xml.trim().endsWith("</urlset>")).toBe(true);
  });

  it("skips entries with no url rather than throwing", () => {
    const xml = renderSitemapXml([
      { url: "", changeFrequency: "weekly", priority: 0.1 },
      { url: siteUrl("/faq"), changeFrequency: "weekly", priority: 0.6 }
    ]);
    expect(xml).toContain(`<loc>${siteUrl("/faq")}</loc>`);
    expect(xml).not.toContain("<loc></loc>");
  });

  it("omits the xhtml namespace when no row carries hreflang", () => {
    const xml = renderSitemapXml([
      { url: siteUrl("/docs"), changeFrequency: "weekly", priority: 0.5 },
      {
        url: siteUrl("/docs/api"),
        changeFrequency: "weekly",
        priority: 0.6,
        alternates: { languages: {} }
      }
    ]);
    expect(xml).not.toContain("xmlns:xhtml");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.5</priority>");
  });

  it("skips a missing loc and an empty hreflang href rather than throwing", () => {
    const xml = renderSitemapXml([
      null as unknown as { url: string; changeFrequency: "weekly"; priority: number },
      { url: 1 as unknown as string, changeFrequency: "weekly", priority: 0.1 },
      {
        url: siteUrl("/faq"),
        changeFrequency: "weekly",
        priority: 0.6,
        alternates: { languages: { en: siteUrl("/faq"), es: "" } }
      }
    ]);
    expect(xml).toContain(`<loc>${siteUrl("/faq")}</loc>`);
    expect(xml).toContain(`hreflang="en"`);
    expect(xml).not.toContain(`hreflang="es"`);
  });

  it("renders an empty urlset when the entry list is not an array", () => {
    const xml = renderSitemapXml(null as unknown as []);
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });
});

describe("the sitemap.xml route", () => {
  it("always returns 200 XML even when the blog DB is unreachable", async () => {
    // setup-env.ts strips SUPABASE_SERVICE_ROLE_KEY, so the real
    // listPublishedPosts path throws. That used to be able to 500 the
    // metadata route; the handler must swallow it.
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    const xml = await res.text();
    const urls = parseSitemapUrls(xml);
    expect(urls).toContain(siteUrl("/"));
    expect(urls).not.toContain(`${SITE_URL}/`);
    for (const path of SEO_PILLAR_PATHS) {
      expect(urls).toContain(siteUrl(path));
      expect(urls).toContain(siteUrl(`/es${path}`));
    }
    for (const industry of INDUSTRIES) {
      expect(urls).toContain(siteUrl(`/industries/${industry.slug}`));
    }
    for (const comparison of COMPARISONS) {
      expect(urls).toContain(siteUrl(`/compare/${comparison.slug}`));
    }
  });
});
