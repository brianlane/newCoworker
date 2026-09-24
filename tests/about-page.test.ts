/**
 * /about is the entity page answer engines cite for what the product is.
 * The AEO blocks (formula, capabilities, audience, key facts, FAQ) have to
 * stay in the HTML, in that order, in both catalogs. Source-level plus
 * catalog assertions, same approach as ai-answering-service-page.test.ts:
 * the page is an async server component.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import { buildLlmsTxt } from "@/lib/marketing/llms-content";
import { SITE_URL } from "@/lib/marketing/site-url";

const ROOT = join(import.meta.dirname, "..");
const PAGE = join(ROOT, "src/app/(marketing)/about/page.tsx");

const EM_DASH = "\u2014";

const BANNED_VISIBLE =
  /\bSMBs?\b|small business|pequeñ[oa]s negocios|real estate|realtor|bienes ra[ií]ces|inmobiliari|AI receptionist|recepcionista|GoHighLevel|Smith\.ai|Zinng|Marblism|Follow Up Boss|\bfounder\b/i;

type CatalogNode = Record<string, unknown>;

function aboutNs(catalog: typeof en): CatalogNode {
  const node = (catalog.marketing as CatalogNode).about;
  expect(node, "marketing.about is missing from the catalog").toBeTruthy();
  return node as CatalogNode;
}

function flattenStrings(obj: unknown, prefix = ""): { key: string; value: string }[] {
  if (typeof obj === "string") return [{ key: prefix, value: obj }];
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as CatalogNode).flatMap(([k, v]) =>
    flattenStrings(v, prefix ? `${prefix}.${k}` : k)
  );
}

function pageSource(): string {
  expect(existsSync(PAGE)).toBe(true);
  return readFileSync(PAGE, "utf8");
}

function constBlock(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`);
  expect(start, `${name} must be declared on the about page`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("] as const", start);
  expect(end, `${name} must end with ] as const`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function quoted(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("/about AEO structure", () => {
  const src = pageSource();

  it("puts the formula, then what it does, the audience, key facts, and the FAQ", () => {
    const order = [
      'line("valueProp")',
      'line("storyP1")',
      'line("doesTitle")',
      'line("icpTitle")',
      'line("factsTitle")',
      "<dl",
      'line("faqTitle")',
      'line("principlesTitle")'
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = src.indexOf(needle);
      expect(at, `${needle} is missing or out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("renders capabilities as H3s through FeatureGrid", () => {
    expect(src).toContain("<FeatureGrid");
    expect(src).toContain("features={capabilities}");
    const capabilityKeys = [...constBlock(src, "CAPABILITY_DEFS").matchAll(/key:\s*"([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(capabilityKeys.length).toBeGreaterThanOrEqual(4);
    expect(readFileSync(join(ROOT, "src/components/marketing/sections.tsx"), "utf8")).toMatch(
      /<h3[^>]*>\{feature\.title\}<\/h3>/
    );
  });

  it("renders the audience as a plain bullet list", () => {
    const icp = quoted(constBlock(src, "ICP_KEYS"));
    expect(icp.length).toBeGreaterThanOrEqual(3);
    const listAt = src.indexOf("<ul");
    const icpAt = src.indexOf('line("icpTitle")');
    const factsAt = src.indexOf('line("factsTitle")');
    expect(listAt).toBeGreaterThan(icpAt);
    expect(listAt).toBeLessThan(factsAt);
    expect(src).toContain("<li");
  });

  it("renders key facts as a plain definition list, dt and dd as direct children", () => {
    const facts = quoted(constBlock(src, "FACT_KEYS"));
    expect(facts.length).toBeGreaterThanOrEqual(5);
    const dlAt = src.indexOf("<dl");
    const dlEnd = src.indexOf("</dl>", dlAt);
    const dl = src.slice(dlAt, dlEnd);
    expect(dl).toContain("<dt");
    expect(dl).toContain("<dd");
    expect(dl).not.toContain("<div");
    expect(dl).toContain("<Fragment");
  });

  it("fills the {brand} placeholder from the nav brand, so the name is not copied into new strings", () => {
    expect(src).toContain('getTranslations("marketing.nav")');
    expect(src).toContain('nav("brand")');
    expect(src).toContain("t(key, { brand })");
  });

  it("emits FAQPage JSON-LD from the same items the accordion shows", () => {
    expect(src).toContain('import { faqPageJsonLd } from "@/lib/marketing/faq-json-ld"');
    expect(src).toContain("faqPageJsonLd(");
    expect(src).toContain("<FaqAccordion");
    expect(src).toContain('import { JsonLd } from "@/components/marketing/JsonLd"');
    const faqKeys = quoted(constBlock(src, "FAQ_KEYS"));
    expect(faqKeys.length).toBeGreaterThanOrEqual(4);
  });
});

describe.each([
  ["en", en],
  ["es", es]
] as const)("/about catalog (%s)", (locale, catalog) => {
  const copy = aboutNs(catalog);
  const flat = flattenStrings(copy);

  it("has no em dash and none of the banned framings", () => {
    const offenders = flat.filter(
      (row) => row.value.includes(EM_DASH) || BANNED_VISIBLE.test(row.value)
    );
    expect(offenders.map((row) => `${row.key}: ${row.value}`)).toEqual([]);
  });

  it("states a formula value prop that names the AI coworker and Meta leads", () => {
    const valueProp = String(copy.valueProp);
    expect(valueProp.length).toBeGreaterThan(40);
    if (locale === "en") {
      expect(valueProp).toMatch(/^\{brand\} is an AI coworker that contacts inbound leads/);
      expect(valueProp).toMatch(/Meta leads/);
    } else {
      expect(valueProp).toMatch(/^\{brand\} es un coworker de IA que contacta leads entrantes/);
      expect(valueProp).toMatch(/leads de Meta/);
    }
    expect(String(copy.valuePropHeading).length).toBeGreaterThan(0);
    const brand = String((catalog.marketing as CatalogNode).nav && ((catalog.marketing as CatalogNode).nav as CatalogNode).brand);
    const resolved = valueProp.replaceAll("{brand}", brand);
    expect(resolved).not.toContain("{brand}");
    expect(resolved.startsWith(`${brand} `)).toBe(true);
  });

  it("names the capabilities section and gives each H3 a concrete title", () => {
    expect(copy.doesTitle).toBe(locale === "en" ? "What {brand} does" : "Qué hace {brand}");
    const src = pageSource();
    const capabilityKeys = [...constBlock(src, "CAPABILITY_DEFS").matchAll(/key:\s*"([^"]+)"/g)].map(
      (match) => match[1]
    );
    for (const key of capabilityKeys) {
      const node = copy[key] as CatalogNode;
      expect(typeof node?.title, `${locale} ${key}.title`).toBe("string");
      expect(String(node.title).length, `${locale} ${key}.title`).toBeGreaterThan(8);
      expect(typeof node?.description, `${locale} ${key}.description`).toBe("string");
      expect(String(node.description).length).toBeGreaterThan(40);
    }
  });

  it("describes the audience as businesses that want inbound-lead help, especially Meta", () => {
    const title = String(copy.icpTitle);
    if (locale === "en") {
      expect(title).toBe("Businesses that want help contacting inbound leads");
    } else {
      expect(title).toBe("Negocios que quieren ayuda para contactar leads entrantes");
    }
    const src = pageSource();
    const icpKeys = quoted(constBlock(src, "ICP_KEYS"));
    const bullets = icpKeys.map((key) => String(copy[key]));
    expect(bullets.every((bullet) => bullet.length > 40)).toBe(true);
    const joined = `${copy.icpSubtitle ?? ""}\n${bullets.join("\n")}`;
    expect(joined).toMatch(/Meta/i);
  });

  it("gives every key fact a term and a detail", () => {
    expect(copy.factsTitle).toBe(locale === "en" ? "Key facts" : "Datos clave");
    const facts = copy.facts as CatalogNode;
    expect(facts && typeof facts === "object").toBe(true);
    const src = pageSource();
    const factKeys = quoted(constBlock(src, "FACT_KEYS"));
    for (const key of factKeys) {
      const node = facts[key] as CatalogNode;
      expect(typeof node?.term, `${locale} facts.${key}.term`).toBe("string");
      expect(String(node.term).length).toBeGreaterThan(0);
      expect(typeof node?.detail, `${locale} facts.${key}.detail`).toBe("string");
      expect(String(node.detail).length).toBeGreaterThan(6);
    }
    const details = factKeys.map((key) => String((facts[key] as CatalogNode).detail)).join("\n");
    expect(details).toMatch(/Meta/);
    expect(details).toMatch(/Standard/i);
  });

  it("answers a Meta-lead question in the FAQ", () => {
    const src = pageSource();
    const faqKeys = quoted(constBlock(src, "FAQ_KEYS"));
    const pairs = faqKeys.map((key) => copy[key] as CatalogNode);
    expect(pairs.every((pair) => typeof pair?.q === "string" && typeof pair?.a === "string")).toBe(
      true
    );
    const blob = pairs.map((pair) => `${pair.q} ${pair.a}`).join("\n");
    expect(blob).toMatch(/Meta/);
    if (locale === "en") {
      expect(blob).toMatch(/not used to train/i);
    } else {
      expect(blob).toMatch(/no se usan para entrenar/i);
    }
  });
});

describe("/about machine brief", () => {
  it("points assistants at the about page for what it does and who it is for", () => {
    const txt = buildLlmsTxt();
    expect(txt).toContain(`[About](${SITE_URL}/about): what the AI coworker does, who it is for, and key facts`);
  });
});
