/**
 * /after-hours-answering is a demand-side SEO landing. Searchers type
 * "after hours answering" and "phone answering"; the HTML title, meta, OG,
 * and JSON-LD match that intent. Visible copy stays on-brand: AI coworker,
 * never assistant / receptionist / virtual receptionist in the body, H1, or
 * buttons. Those SEO phrases stay out of visible copy too.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import {
  SPANISH_MARKETING_PREFIXES,
  sitemapPathsFor
} from "@/lib/i18n/es-routes";
import { buildLlmsTxt, SITE_URL } from "@/lib/marketing/llms-content";
import { buildSitemap } from "@/lib/marketing/sitemap";
import { siteUrl } from "@/lib/marketing/site-url";

const ROOT = join(__dirname, "..");
const PAGE = join(ROOT, "src/app/(marketing)/after-hours-answering/page.tsx");
const OG = join(ROOT, "src/app/(marketing)/after-hours-answering/opengraph-image.tsx");
const NS = "afterHoursAnsweringPage";

type Catalog = Record<string, unknown>;

const REQUIRED_KEYS = [
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "jsonLdName",
  "jsonLdServiceType",
  "jsonLdDescription",
  "heroEyebrow",
  "heroTitle",
  "heroHighlight",
  "heroSubtitle",
  "primaryCta",
  "secondaryCta",
  "contactCta",
  "problemEyebrow",
  "problemTitle",
  "problemBody",
  "handlesEyebrow",
  "handlesTitle",
  "nights.title",
  "nights.description",
  "booking.title",
  "booking.description",
  "missed.title",
  "missed.description",
  "overflow.title",
  "overflow.description",
  "followup.title",
  "followup.description",
  "private.title",
  "private.description",
  "dayEyebrow",
  "dayTitle",
  "day1",
  "day2",
  "day3",
  "day4",
  "faqEyebrow",
  "faqTitle",
  "faq1.q",
  "faq1.a",
  "faq2.q",
  "faq2.a",
  "faq3.q",
  "faq3.a",
  "faq4.q",
  "faq4.a",
  "ctaTitle",
  "ctaSubtitle",
  "ctaLabel",
  "contactPrompt",
  "contactLink"
] as const;

const SEO_LEAVES = new Set([
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "jsonLdName",
  "jsonLdServiceType",
  "jsonLdDescription"
]);

function lookup(root: unknown, dotted: string): unknown {
  let node = root;
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function flattenStrings(node: unknown, prefix = ""): { key: string; value: string }[] {
  if (typeof node === "string") return [{ key: prefix, value: node }];
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flattenStrings(v, prefix ? `${prefix}.${k}` : k)
  );
}

function pageCatalog(catalog: Catalog): Catalog {
  const marketing = catalog.marketing as Catalog | undefined;
  const page = marketing?.[NS];
  expect(page, `marketing.${NS} missing`).toBeTruthy();
  return page as Catalog;
}

function readPageSource(): string {
  expect(existsSync(PAGE), `${PAGE} missing: /after-hours-answering would 404`).toBe(true);
  return readFileSync(PAGE, "utf8");
}

describe("/after-hours-answering route", () => {
  it("ships an App Router page so the URL returns 200, not 404", () => {
    const src = readPageSource();
    expect(src).toMatch(/export async function generateMetadata/);
    expect(src).toMatch(/export default async function/);
    expect(src).toContain('esAlternatesForRequest("/after-hours-answering")');
    expect(src).toContain('getTranslations("marketing.afterHoursAnsweringPage")');
  });

  it("is in the sitemap (English plus the /es twin)", async () => {
    const entries = await buildSitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(siteUrl("/after-hours-answering"));
    expect(urls).toContain(siteUrl("/es/after-hours-answering"));
    expect(entries.find((entry) => entry.url === siteUrl("/after-hours-answering"))?.priority).toBe(
      0.9
    );
    expect(SPANISH_MARKETING_PREFIXES).toContain("/after-hours-answering");
    expect(sitemapPathsFor("/after-hours-answering")).toEqual([
      "/after-hours-answering",
      "/es/after-hours-answering"
    ]);
  });

  it("lists the URL in llms.txt so assistants can cite the landing", () => {
    expect(buildLlmsTxt()).toContain(`${SITE_URL}/after-hours-answering`);
  });

  it("CTAs go to /onboard, /pricing, and /contact", () => {
    const src = readPageSource();
    expect(src).toContain('href="/onboard"');
    expect(src).toContain('href="/pricing"');
    expect(src).toContain('href="/contact"');
  });

  it("emits JSON-LD from the SEO catalog keys", () => {
    const src = readPageSource();
    expect(src).toContain("JsonLd");
    expect(src).toContain('t("jsonLdName")');
    expect(src).toContain('t("jsonLdServiceType")');
    expect(src).toContain('t("jsonLdDescription")');
  });

  it("ships a social card, since OG is an allowed SEO surface", () => {
    expect(existsSync(OG), "opengraph-image.tsx missing").toBe(true);
    const og = readFileSync(OG, "utf8");
    expect(og).toMatch(/after[- ]hours/i);
    expect(og).toMatch(/answering/i);
  });
});

describe.each([
  ["en", en],
  ["es", es]
] as const)("after-hours answering copy (%s)", (locale, catalog) => {
  it("has every key the page renders", () => {
    const page = pageCatalog(catalog as Catalog);
    for (const key of REQUIRED_KEYS) {
      const value = lookup(page, key);
      expect(typeof value, `marketing.${NS}.${key}`).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it("puts after-hours answering intent in title, meta, OG, and JSON-LD", () => {
    const page = pageCatalog(catalog as Catalog);
    const seo = [...SEO_LEAVES].map((leaf) => String(page[leaf] ?? "")).join("\n");
    if (locale === "en") {
      expect(seo).toMatch(/after[- ]hours/i);
      expect(seo).toMatch(/phone answering|after[- ]hours answering/i);
      expect(String(page.metaTitle)).toMatch(/after[- ]hours/i);
      expect(String(page.metaTitle)).toMatch(/answering/i);
      expect(String(page.metaDescription)).toMatch(/after[- ]hours|phone answering/i);
      expect(String(page.ogTitle)).toMatch(/after[- ]hours/i);
      expect(String(page.jsonLdName)).toMatch(/after[- ]hours/i);
      expect(String(page.jsonLdServiceType)).toMatch(/answering/i);
    } else {
      expect(seo).toMatch(/fuera de horario/i);
      expect(String(page.metaTitle)).toMatch(/fuera de horario/i);
      expect(String(page.ogTitle)).toMatch(/fuera de horario/i);
      expect(String(page.jsonLdName)).toMatch(/fuera de horario/i);
    }
  });

  it("keeps visible copy on AI coworker, never the banned product labels", () => {
    const page = pageCatalog(catalog as Catalog);
    const visible = flattenStrings(page).filter(({ key }) => !SEO_LEAVES.has(key.split(".").pop()!));
    const blob = visible.map((row) => row.value).join("\n");
    expect(blob.toLowerCase()).toContain("coworker");

    const forbidden =
      locale === "en"
        ? /\b(assistants?|receptionists?)\b/i
        : /\b(asistentes?|recepcionistas?)\b/i;
    const offenders = visible.filter((row) => forbidden.test(row.value)).map((row) => row.key);
    expect(offenders).toEqual([]);

    const seoPhrases =
      locale === "en"
        ? /after[- ]hours answering|phone answering|virtual receptionist|answering service/i
        : /recepcionista virtual|servicio de contestador/i;
    const seoOffenders = visible.filter((row) => seoPhrases.test(row.value)).map((row) => row.key);
    expect(seoOffenders).toEqual([]);
  });

  it("never uses an em dash", () => {
    expect(JSON.stringify(pageCatalog(catalog as Catalog))).not.toContain("\u2014");
  });
});
