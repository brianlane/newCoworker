/**
 * /ai-answering-service is the buyer-intent landing for people searching
 * "AI answering service". The URL and metadata carry that phrase. Visible
 * UI stays coworker-voiced: never assistant, receptionist, or virtual
 * receptionist in body, H1, or buttons. Source-level plus catalog
 * assertions, matching blog-post-cta.test.ts: the page is an async server
 * component, so reading it is cheaper than a render harness.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import {
  isMirroredMarketingPath,
  isSpanishMarketingPath,
  sitemapPathsFor
} from "@/lib/i18n/es-routes";
import { buildLlmsTxt } from "@/lib/marketing/llms-content";
import { SITE_URL } from "@/lib/marketing/site-url";

const ROOT = join(import.meta.dirname, "..");
const PAGE = join(ROOT, "src/app/(marketing)/ai-answering-service/page.tsx");
const OG = join(ROOT, "src/app/(marketing)/ai-answering-service/opengraph-image.tsx");
const SITEMAP = join(ROOT, "src/app/sitemap.ts");
const PATH = "/ai-answering-service";

const BANNED_VISIBLE = /\bassistants?\b|\breceptionists?\b|virtual receptionist/i;
const EN_SEO = /answering service/i;
const ES_SEO = /servicio de contestaci[oó]n/i;

type CatalogNode = Record<string, unknown>;

function marketingNs(catalog: typeof en): CatalogNode {
  const node = (catalog.marketing as CatalogNode).aiAnsweringServicePage;
  expect(node, "marketing.aiAnsweringServicePage is missing from the catalog").toBeTruthy();
  expect(typeof node).toBe("object");
  return node as CatalogNode;
}

function flattenStrings(obj: unknown, prefix = ""): { key: string; value: string }[] {
  if (typeof obj === "string") return [{ key: prefix, value: obj }];
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as CatalogNode).flatMap(([k, v]) =>
    flattenStrings(v, prefix ? `${prefix}.${k}` : k)
  );
}

const META_LEAVES = new Set([
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "schemaName",
  "schemaServiceType"
]);

function isMetaKey(key: string): boolean {
  const leaf = key.split(".").pop() ?? key;
  return META_LEAVES.has(leaf);
}

function pageSource(): string {
  expect(existsSync(PAGE), `${PATH} page.tsx must exist so the route is 200, not 404`).toBe(
    true
  );
  return readFileSync(PAGE, "utf8");
}

describe("/ai-answering-service route", () => {
  it("has a marketing page module, so the App Router serves 200 rather than 404", () => {
    expect(existsSync(PAGE)).toBe(true);
    const src = pageSource();
    expect(src).toMatch(/export default async function/);
    expect(src).toMatch(/export async function generateMetadata/);
    expect(src).not.toMatch(/notFound\(\)/);
  });

  it("self-canonicals through esAlternatesForRequest so /es twin is indexed", () => {
    const src = pageSource();
    expect(src).toContain('esAlternatesForRequest("/ai-answering-service")');
  });

  it("is a bilingual marketing mirror", () => {
    expect(isMirroredMarketingPath(PATH)).toBe(true);
    expect(isSpanishMarketingPath(`/es${PATH}`)).toBe(true);
    expect(sitemapPathsFor(PATH)).toEqual([PATH, `/es${PATH}`]);
  });

  it("is listed in the sitemap static routes", () => {
    expect(readFileSync(SITEMAP, "utf8")).toContain(`path: "${PATH}"`);
  });
});

describe("/ai-answering-service metadata carries answering-service intent", () => {
  it.each([
    ["en", en, EN_SEO],
    ["es", es, ES_SEO]
  ] as const)("%s title, description, OG, and schema name the buyer term", (locale, catalog, seo) => {
    const copy = marketingNs(catalog);
    for (const key of ["metaTitle", "metaDescription", "ogTitle", "ogDescription"] as const) {
      const value = copy[key];
      expect(typeof value, `${locale} ${key}`).toBe("string");
      expect(value as string, `${locale} ${key}`).toMatch(seo);
    }
    expect(copy.schemaName as string, `${locale} schemaName`).toMatch(seo);
    expect(copy.schemaServiceType as string, `${locale} schemaServiceType`).toMatch(seo);
  });

  it("keeps the page title free of a brand suffix (root layout templates it)", () => {
    expect(marketingNs(en).metaTitle as string).not.toMatch(/\|\s*$/);
    expect(marketingNs(en).metaTitle as string).not.toMatch(/\|/);
    expect(marketingNs(es).metaTitle as string).not.toMatch(/\|/);
  });

  it("keeps the brand on the OG title, which Next.js never templates", () => {
    expect(marketingNs(en).ogTitle as string).toMatch(/\|/);
    expect(marketingNs(es).ogTitle as string).toMatch(/\|/);
  });
});

describe("/ai-answering-service visible copy stays coworker-voiced", () => {
  it.each([
    ["en", en],
    ["es", es]
  ] as const)("%s body, H1, and button strings omit assistant/receptionist", (locale, catalog) => {
    const visible = flattenStrings(marketingNs(catalog)).filter((row) => !isMetaKey(row.key));
    expect(visible.length, `${locale} visible strings`).toBeGreaterThan(8);
    const offenders = visible.filter((row) => BANNED_VISIBLE.test(row.value));
    expect(
      offenders.map((row) => `${row.key}: ${row.value}`),
      `${locale} visible copy must not name assistant/receptionist`
    ).toEqual([]);
  });

  it("English visible H1 and CTAs name the coworker, not the SEO phrase", () => {
    const copy = marketingNs(en);
    const h1 = `${copy.heroTitle} ${copy.heroHighlight}`;
    expect(h1).toMatch(/coworker/i);
    expect(h1).not.toMatch(EN_SEO);
    expect(copy.heroCta as string).not.toMatch(EN_SEO);
    expect(copy.heroCta as string).not.toMatch(BANNED_VISIBLE);
    expect(copy.heroSecondaryCta as string).not.toMatch(BANNED_VISIBLE);
    expect(copy.ctaLabel as string).not.toMatch(BANNED_VISIBLE);
  });

  it("does not put the SEO phrase in visible English body strings", () => {
    const visible = flattenStrings(marketingNs(en)).filter((row) => !isMetaKey(row.key));
    const offenders = visible.filter((row) => EN_SEO.test(row.value));
    expect(offenders.map((row) => `${row.key}: ${row.value}`)).toEqual([]);
  });
});

describe("/ai-answering-service page wiring", () => {
  it("CTAs point at onboard, pricing, and contact", () => {
    const src = pageSource();
    expect(src).toContain('href="/onboard"');
    expect(src).toContain('href="/pricing"');
    expect(src).toContain('href="/contact"');
  });

  it("renders coworker-voiced H1 keys through PageHero", () => {
    const src = pageSource();
    expect(src).toContain("<PageHero");
    expect(src).toContain('t("heroTitle")');
    expect(src).toContain('t("heroHighlight")');
    expect(src).toContain('t("heroCta")');
  });

  it("emits Service + FAQPage JSON-LD from the schema keys", () => {
    const src = pageSource();
    expect(src).toContain('import { JsonLd } from "@/components/marketing/JsonLd"');
    expect(src).toContain('"Service"');
    expect(src).toContain('"FAQPage"');
    expect(src).toContain('t("schemaName")');
    expect(src).toContain('t("schemaServiceType")');
  });

  it("pins feature and problem catalog keys used via template literals", () => {
    const src = pageSource();
    const featureKeys = [...src.matchAll(/\{\s*key:\s*"(\w+)",\s*Icon:/g)].map((m) => m[1]);
    const problemKeys = [...src.matchAll(/\{\s*key:\s*"(problem\d+)"/g)].map((m) => m[1]);
    expect(featureKeys.length).toBeGreaterThanOrEqual(4);
    expect(problemKeys).toEqual(["problem1", "problem2", "problem3"]);
    for (const catalog of [en, es]) {
      const copy = marketingNs(catalog);
      for (const key of featureKeys) {
        expect(typeof (copy[key] as CatalogNode)?.title, key).toBe("string");
        expect(typeof (copy[key] as CatalogNode)?.description, key).toBe("string");
      }
      for (const key of problemKeys) {
        expect(typeof (copy[key] as CatalogNode)?.title, key).toBe("string");
        expect(typeof (copy[key] as CatalogNode)?.description, key).toBe("string");
      }
    }
  });

  it("has a social card that can carry the buyer term", () => {
    expect(existsSync(OG)).toBe(true);
    expect(readFileSync(OG, "utf8")).toMatch(EN_SEO);
  });
});

describe("/ai-answering-service discoverability", () => {
  it("is listed in llms.txt so assistants can cite the landing", () => {
    expect(buildLlmsTxt()).toContain(`${SITE_URL}${PATH}`);
  });
});
