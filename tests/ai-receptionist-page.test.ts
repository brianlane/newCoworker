/**
 * /ai-receptionist is the demand-side SEO landing for buyers who search
 * "AI receptionist". Visible copy still calls the product an AI coworker:
 * the search phrase lives only in title, meta description, OG, and JSON-LD.
 *
 * Source-level plus catalog assertions, matching blog-post-cta.test.ts:
 * the page is an async server component wired to next-intl, so its contract
 * is cheaper to pin by reading it than by standing up a render harness.
 * The App Router maps `src/app/(marketing)/ai-receptionist/page.tsx` to
 * HTTP 200 on `/ai-receptionist` (and `/es/ai-receptionist` via the
 * mirrored-prefix rewrite).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import {
  localizedMarketingHref,
  sitemapPathsFor,
  SPANISH_MARKETING_PREFIXES
} from "@/lib/i18n/es-routes";
import { buildLlmsTxt } from "@/lib/marketing/llms-content";
import { SITE_URL } from "@/lib/marketing/site-url";

const ROOT = join(import.meta.dirname, "..");
const PAGE = join(ROOT, "src/app/(marketing)/ai-receptionist/page.tsx");
const SITEMAP = join(ROOT, "src/app/sitemap.ts");
const OG = join(ROOT, "src/app/(marketing)/ai-receptionist/opengraph-image.tsx");
const TWITTER = join(ROOT, "src/app/(marketing)/ai-receptionist/twitter-image.tsx");

const SEO_KEYS = [
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "jsonLdAlternateName",
  "jsonLdServiceName",
  "jsonLdServiceType"
] as const;

const H1_KEYS = ["heroTitle", "heroHighlight"] as const;
const BUTTON_KEYS = ["startCta", "pricingCta", "contactCta", "ctaLabel"] as const;

const VISIBLE_KEYS = [
  ...H1_KEYS,
  ...BUTTON_KEYS,
  "heroEyebrow",
  "heroSubtitle",
  "problemEyebrow",
  "problemTitle",
  "problemSubtitle",
  "p1Title",
  "p1Body",
  "p2Title",
  "p2Body",
  "p3Title",
  "p3Body",
  "doesEyebrow",
  "doesTitle",
  "doesSubtitle",
  "does1Title",
  "does1Body",
  "does2Title",
  "does2Body",
  "does3Title",
  "does3Body",
  "does4Title",
  "does4Body",
  "contrastEyebrow",
  "contrastTitle",
  "contrastBody",
  "contrastCompareCta",
  "stat1Value",
  "stat1Label",
  "stat2Value",
  "stat2Label",
  "stat3Value",
  "stat3Label",
  "stat4Value",
  "stat4Label",
  "faqEyebrow",
  "faqTitle",
  "faq1q",
  "faq1a",
  "faq2q",
  "faq2a",
  "faq3q",
  "faq3a",
  "faq4q",
  "faq4a",
  "ctaTitle",
  "ctaSubtitle"
] as const;

/** Product-label ban on visible UI: assistant, receptionist, virtual receptionist. */
const BANNED_VISIBLE = /assistant|receptionist|asistente|recepcionista/i;

type Catalog = Record<string, unknown>;

const CATALOGS: [string, Catalog][] = [
  ["en", (en.marketing as Catalog).callAnsweringPage as Catalog],
  ["es", (es.marketing as Catalog).callAnsweringPage as Catalog]
];

function lookup(root: Catalog | undefined, key: string): unknown {
  if (!root || typeof root !== "object") return undefined;
  return root[key];
}

describe("/ai-receptionist route", () => {
  it("exists as an App Router page (HTTP 200, not 404)", () => {
    expect(existsSync(PAGE), "src/app/(marketing)/ai-receptionist/page.tsx").toBe(true);
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/export async function generateMetadata/);
    expect(src).toMatch(/export default async function/);
  });

  it("ships social cards like the other marketing landings", () => {
    expect(existsSync(OG), "opengraph-image.tsx").toBe(true);
    expect(existsSync(TWITTER), "twitter-image.tsx").toBe(true);
  });

  it("is a bilingual sitemap route: /ai-receptionist and /es/ai-receptionist", () => {
    expect(SPANISH_MARKETING_PREFIXES).toContain("/ai-receptionist");
    expect(sitemapPathsFor("/ai-receptionist")).toEqual([
      "/ai-receptionist",
      "/es/ai-receptionist"
    ]);
    expect(readFileSync(SITEMAP, "utf8")).toMatch(/path:\s*"\/ai-receptionist"/);
  });
});

describe.each(CATALOGS)("/ai-receptionist copy (%s)", (locale, page) => {
  it("has SEO fields whose title and description carry receptionist intent", () => {
    expect(page, `marketing.callAnsweringPage missing in ${locale}.json`).toBeTruthy();
    for (const key of SEO_KEYS) {
      const value = lookup(page, key);
      expect(typeof value, `${locale}.${key}`).toBe("string");
      expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
    }
    const receptionist = locale === "es" ? /recepcionista/i : /receptionist/i;
    expect(lookup(page, "metaTitle")).toMatch(receptionist);
    expect(lookup(page, "metaDescription")).toMatch(receptionist);
    expect(lookup(page, "ogTitle")).toMatch(receptionist);
    expect(lookup(page, "ogDescription")).toMatch(receptionist);
  });

  it("keeps visible body, H1, and button copy free of assistant/receptionist labels", () => {
    const offenders: string[] = [];
    for (const key of VISIBLE_KEYS) {
      const value = lookup(page, key);
      expect(typeof value, `${locale}.${key}`).toBe("string");
      const text = value as string;
      expect(text.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      if (BANNED_VISIBLE.test(text)) offenders.push(`${locale}.${key} = ${JSON.stringify(text)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("uses coworker-voiced H1 and CTA buttons that point people onward", () => {
    const h1 = H1_KEYS.map((k) => String(lookup(page, k))).join(" ");
    expect(h1.toLowerCase()).toMatch(/coworker|empleado/);
    expect(String(lookup(page, "startCta")).length).toBeGreaterThan(0);
    expect(String(lookup(page, "pricingCta")).length).toBeGreaterThan(0);
    expect(String(lookup(page, "contactCta")).length).toBeGreaterThan(0);
  });
});

describe("/ai-receptionist page source", () => {
  it("renders JSON-LD for SoftwareApplication and Service, plus a FAQPage", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/from "@\/components\/marketing\/JsonLd"/);
    expect(src).toContain('"SoftwareApplication"');
    expect(src).toContain('"Service"');
    expect(src).toContain('"FAQPage"');
    expect(src).toContain('"BreadcrumbList"');
  });

  it("puts strong CTAs on the existing onboard, pricing, and contact routes", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain('href="/onboard"');
    expect(src).toContain('href="/pricing"');
    expect(src).toContain('href="/contact"');
    expect(src).toMatch(/<CtaBanner/);
    expect(src).toMatch(/ctaHref="\/onboard"/);
  });

  it("keeps the hero contact href locale-aware so /es/ai-receptionist stays on /es/contact", () => {
    const src = readFileSync(PAGE, "utf8");
    const heroStart = src.indexOf("<PageHero");
    const heroEnd = src.indexOf("</PageHero>");
    expect(heroStart).toBeGreaterThan(-1);
    expect(heroEnd).toBeGreaterThan(heroStart);
    const hero = src.slice(heroStart, heroEnd);
    expect(hero).not.toMatch(/<Link\b[^>]*\bhref=["']\/contact["']/);
    const viaCtaLink = /<CtaLink[\s\S]*?href=["']\/contact["']/.test(hero);
    const viaHelper = /localizedMarketingHref\(\s*["']\/contact["']/.test(hero);
    expect(viaCtaLink || viaHelper, "hero contact must use CtaLink or localizedMarketingHref").toBe(
      true
    );
    expect(localizedMarketingHref("/contact", "es")).toBe("/es/contact");
    expect(localizedMarketingHref("/contact", "en")).toBe("/contact");
  });

  it("keeps receptionist/assistant literals out of the TSX, including H1/button JSX", () => {
    // The route slug itself is the SEO URL and must appear in canonical/JSON-LD
    // urls. Strip it before the visible-source scan so the path is not treated
    // as product-label copy.
    const src = readFileSync(PAGE, "utf8").replaceAll("/ai-receptionist", "").replaceAll("ai-receptionist", "");
    expect(src).not.toMatch(BANNED_VISIBLE);
  });

  it("wires metadata title and description from the SEO catalog keys", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(/getTranslations\("marketing\.callAnsweringPage"\)/);
    expect(src).toMatch(/title:\s*t\("metaTitle"\)/);
    expect(src).toMatch(/description:\s*t\("metaDescription"/);
  });
});

describe("/ai-receptionist machine surfaces", () => {
  it("is listed in llms.txt so assistants can cite the landing", () => {
    expect(buildLlmsTxt()).toContain(`${SITE_URL}/ai-receptionist`);
  });
});
