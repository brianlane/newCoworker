/**
 * Spanish marketing chrome must stay on /es/... URLs.
 *
 * The /es pages already have hreflang pairs and sitemap twins. The gap is
 * the header, footer, and primary CTAs: they still point at bare English
 * paths (/pricing, /features, ...), so a visitor (or crawler) on /es is
 * sent back to English. These tests pin the locale-aware href helper and
 * fail if MarketingNav, MarketingFooter, or CtaLink stop using it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localizedMarketingHref } from "@/lib/i18n/es-routes";

const ROOT = join(import.meta.dirname, "..");

const NAV_SRC = readFileSync(
  join(ROOT, "src/components/marketing/MarketingNav.tsx"),
  "utf8"
);
const FOOTER_SRC = readFileSync(
  join(ROOT, "src/components/marketing/MarketingFooter.tsx"),
  "utf8"
);
const CTA_SRC = readFileSync(
  join(ROOT, "src/components/marketing/CtaLink.tsx"),
  "utf8"
);

/**
 * Representative marketing paths from the 2026-09-22 SEO audit. On /es
 * pages the chrome currently emits every one of these as a bare English
 * href, with zero /es/... nav links.
 */
const AUDIT_MARKETING_PATHS = [
  "/about",
  "/blog",
  "/compare",
  "/contact",
  "/faq",
  "/features",
  "/industries",
  "/integrations",
  "/pricing",
  "/security",
  "/onboard"
] as const;

function listedHrefs(src: string): string[] {
  return [...src.matchAll(/href:\s*"(\/[^"]+)"/g)].map((m) => m[1]);
}

function jsxStringHrefs(src: string): string[] {
  return [...src.matchAll(/\bhref=["'](\/[^"']+)["']/g)].map((m) => m[1]);
}

function chromeSourceHrefs(): string[] {
  return [
    "/",
    ...listedHrefs(NAV_SRC),
    ...listedHrefs(FOOTER_SRC),
    ...jsxStringHrefs(NAV_SRC),
    ...jsxStringHrefs(FOOTER_SRC)
  ];
}

function resolvedChromeHrefs(locale: "en" | "es"): string[] {
  return [...new Set(chromeSourceHrefs().map((href) => localizedMarketingHref(href, locale)))];
}

describe("localizedMarketingHref", () => {
  it("prefixes every audit marketing path when locale is es", () => {
    for (const path of AUDIT_MARKETING_PATHS) {
      expect(localizedMarketingHref(path, "es")).toBe(`/es${path}`);
    }
    expect(localizedMarketingHref("/", "es")).toBe("/es");
  });

  it("keeps English marketing paths unprefixed", () => {
    for (const path of AUDIT_MARKETING_PATHS) {
      expect(localizedMarketingHref(path, "en")).toBe(path);
    }
    expect(localizedMarketingHref("/", "en")).toBe("/");
  });

  it("does not double-prefix an already Spanish marketing path", () => {
    expect(localizedMarketingHref("/es/pricing", "es")).toBe("/es/pricing");
    expect(localizedMarketingHref("/es", "es")).toBe("/es");
  });

  it("leaves non-mirrored and non-path hrefs alone on es", () => {
    expect(localizedMarketingHref("/dashboard", "es")).toBe("/dashboard");
    expect(localizedMarketingHref("/docs/api", "es")).toBe("/docs/api");
    expect(localizedMarketingHref("/llms.txt", "es")).toBe("/llms.txt");
    expect(localizedMarketingHref("tel:+16023131823", "es")).toBe("tel:+16023131823");
    expect(localizedMarketingHref("https://example.com/pricing", "es")).toBe(
      "https://example.com/pricing"
    );
    expect(localizedMarketingHref("//cdn.example.com/x", "es")).toBe("//cdn.example.com/x");
  });

  it("preserves query strings and hashes on mirrored paths", () => {
    expect(localizedMarketingHref("/onboard/questionnaire?tier=starter", "es")).toBe(
      "/es/onboard/questionnaire?tier=starter"
    );
    expect(localizedMarketingHref("/pricing#compare", "es")).toBe("/es/pricing#compare");
    expect(localizedMarketingHref("/contact?topic=white-glove", "en")).toBe(
      "/contact?topic=white-glove"
    );
  });
});

describe("marketing chrome on Spanish locale", () => {
  it("header and footer lists include every audit marketing path", () => {
    const listed = new Set(chromeSourceHrefs());
    for (const path of AUDIT_MARKETING_PATHS) {
      expect(listed, `chrome is missing ${path}`).toContain(path);
    }
  });

  it("ES header, footer, and primary CTAs resolve to /es/{path}, never the bare English path", () => {
    const resolved = resolvedChromeHrefs("es");
    const bareEnglish = AUDIT_MARKETING_PATHS.filter((path) => resolved.includes(path));
    expect(bareEnglish, "bare English marketing paths in ES chrome").toEqual([]);
    for (const path of AUDIT_MARKETING_PATHS) {
      expect(resolved).toContain(`/es${path}`);
    }
    expect(resolved).toContain("/es");
    expect(resolved).not.toContain("/");
  });

  it("EN chrome stays on the unprefixed paths used today", () => {
    const resolved = resolvedChromeHrefs("en");
    for (const path of AUDIT_MARKETING_PATHS) {
      expect(resolved).toContain(path);
      expect(resolved).not.toContain(`/es${path}`);
    }
    expect(resolved).toContain("/");
    expect(resolved).not.toContain("/es");
  });

  it("MarketingNav, MarketingFooter, and CtaLink resolve hrefs through localizedMarketingHref", () => {
    expect(NAV_SRC).toContain("localizedMarketingHref");
    expect(FOOTER_SRC).toContain("localizedMarketingHref");
    expect(CTA_SRC).toContain("localizedMarketingHref");
  });

  it("MarketingNav and MarketingFooter do not pass raw list hrefs to Link", () => {
    expect(NAV_SRC).not.toMatch(/<Link[\s\S]*?\bhref=\{l\.href\}/);
    expect(FOOTER_SRC).not.toMatch(/<Link[\s\S]*?\bhref=\{l\.href\}/);
  });

  it("CtaLink localizes from the active locale, not a hardcoded /es prefix", () => {
    expect(CTA_SRC).toContain("useLocale");
    expect(CTA_SRC).toContain("localizedMarketingHref");
    expect(CTA_SRC).not.toMatch(/href=["']\/es\//);
  });

  it("ES chrome JSX does not hardcode a bare audit marketing path", () => {
    for (const src of [NAV_SRC, FOOTER_SRC, CTA_SRC]) {
      const bare = jsxStringHrefs(src).filter((href) =>
        (AUDIT_MARKETING_PATHS as readonly string[]).includes(href)
      );
      expect(bare).toEqual([]);
    }
  });

  it("homepage compare-plans CTA and plan-card CTAs go through localizedMarketingHref", () => {
    const home = readFileSync(join(ROOT, "src/app/(marketing)/page.tsx"), "utf8");
    const planCard = readFileSync(join(ROOT, "src/components/pricing/PlanCard.tsx"), "utf8");
    const planCards = readFileSync(join(ROOT, "src/components/pricing/PlanCards.tsx"), "utf8");
    const pricing = readFileSync(join(ROOT, "src/app/(marketing)/pricing/page.tsx"), "utf8");
    expect(home).toContain("localizedMarketingHref");
    expect(home).not.toMatch(/<Link\b[^>]*\bhref=["']\/pricing["']/);
    expect(planCard).toContain("localizedMarketingHref");
    expect(planCards).toContain("localizedMarketingHref");
    expect(planCards).not.toMatch(/\bhref=["']\/contact\?topic=white-glove["']/);
    expect(pricing).toContain("localizedMarketingHref");
    expect(pricing).not.toMatch(/<Link\b[^>]*\bhref=["']\/contact\?topic=white-glove["']/);
  });
});
