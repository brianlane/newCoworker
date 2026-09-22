import { describe, expect, it } from "vitest";
import { esAlternates } from "@/lib/i18n/es-routes";
import { sitemapEntriesFor } from "@/lib/marketing/sitemap-entries";
import { SITE_URL, siteUrl } from "@/lib/marketing/site-url";
import { buildLlmsTxt } from "@/lib/marketing/llms-content";

/**
 * Homepage public URL policy: no trailing slash.
 *
 * Next.js metadata (`resolveAbsoluteUrlWithPathname`) turns a relative `"/"`
 * canonical into `URL.origin` when pathname is `/` and `trailingSlash` is
 * false (the default; next.config does not set it). That is SITE_URL with no
 * slash, which already matches JSON-LD `url` and `siteUrl("/")`. The sitemap
 * used to concatenate `${SITE_URL}/` and disagree. These tests pin the three
 * crawler surfaces to that no-slash form, and the generators that emit a
 * public home link.
 */
function htmlHomeUrls(locale: "en" | "es" = "en") {
  const rel = esAlternates("/", locale);
  return {
    canonical: siteUrl(rel.canonical),
    languages: {
      en: siteUrl(rel.languages.en),
      es: siteUrl(rel.languages.es),
      "x-default": siteUrl(rel.languages["x-default"])
    }
  };
}

describe("homepage URL slash policy", () => {
  it("picks the origin with no trailing slash, matching HTML canonical", () => {
    // SITE_URL itself is the canonical host string. Next emits URL.origin for
    // home, which never carries a trailing slash.
    expect(SITE_URL.endsWith("/")).toBe(false);
    expect(siteUrl("/")).toBe(SITE_URL);
    expect(new URL(SITE_URL).origin).toBe(SITE_URL);
    expect(new URL(SITE_URL).origin).not.toBe(`${SITE_URL}/`);
  });

  it("agrees across HTML canonical, sitemap loc, and hreflang for English home", () => {
    const html = htmlHomeUrls("en");
    const [en, es] = sitemapEntriesFor({ path: "/", priority: 1 });

    expect(html.canonical).toBe(SITE_URL);
    expect(html.languages.en).toBe(SITE_URL);
    expect(html.languages["x-default"]).toBe(SITE_URL);
    expect(html.languages.es).toBe(siteUrl("/es"));

    expect(en.url).toBe(html.canonical);
    expect(en.alternates?.languages.en).toBe(html.languages.en);
    expect(en.alternates?.languages.es).toBe(html.languages.es);
    expect(es.url).toBe(html.languages.es);
    expect(es.alternates?.languages.en).toBe(html.languages.en);
    expect(es.alternates?.languages.es).toBe(html.languages.es);

    expect(en.url.endsWith("/")).toBe(false);
    expect(en.alternates?.languages.en.endsWith("/")).toBe(false);
    expect(es.url.endsWith("/")).toBe(false);
    expect(en.url).not.toBe(`${SITE_URL}/`);
  });

  it("agrees for Spanish home: canonical and sitemap loc are siteUrl(\"/es\")", () => {
    const html = htmlHomeUrls("es");
    const [, es] = sitemapEntriesFor({ path: "/", priority: 1 });

    expect(html.canonical).toBe(siteUrl("/es"));
    expect(html.canonical).toBe(`${SITE_URL}/es`);
    expect(html.canonical.endsWith("/")).toBe(false);
    expect(es.url).toBe(html.canonical);
    expect(es.alternates?.languages.es).toBe(html.canonical);
    expect(es.alternates?.languages.en).toBe(SITE_URL);
  });

  it("keeps non-home sitemap locs slash-free at the end, same helper", () => {
    const [en, es] = sitemapEntriesFor({ path: "/pricing", priority: 0.9 });
    expect(en.url).toBe(siteUrl("/pricing"));
    expect(en.url).toBe(`${SITE_URL}/pricing`);
    expect(en.url.endsWith("/")).toBe(false);
    expect(en.alternates?.languages.en).toBe(siteUrl("/pricing"));
    expect(en.alternates?.languages.es).toBe(siteUrl("/es/pricing"));
    expect(es.url).toBe(siteUrl("/es/pricing"));
    expect(es.priority).toBe(0.8);
  });

  it("emits a single English loc for enOnly paths, still via siteUrl", () => {
    const [only] = sitemapEntriesFor({
      path: "/docs/api",
      priority: 0.6,
      enOnly: true
    });
    expect(only.url).toBe(siteUrl("/docs/api"));
    expect(only.alternates).toBeUndefined();
  });

  it("floors a low-priority Spanish twin at 0.1", () => {
    const [, es] = sitemapEntriesFor({ path: "/contact", priority: 0.2 });
    expect(es.priority).toBe(0.1);
    expect(es.url).toBe(siteUrl("/es/contact"));
  });
});

describe("public home links use the same no-slash form", () => {
  it("llms.txt Home entry is siteUrl(\"/\"), not origin-plus-slash", () => {
    const txt = buildLlmsTxt();
    expect(txt).toContain(`[Home](${SITE_URL}):`);
    expect(txt).not.toContain(`[Home](${SITE_URL}/):`);
  });
});
