import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import {
  COMPARE_ROW_COUNT,
  COMPARISONS,
  getComparison
} from "../src/app/(marketing)/compare/data";

type Catalog = Record<string, unknown>;

const CATALOGS: [string, Catalog][] = [
  ["en", (en.marketing as Catalog).compare as Catalog],
  ["es", (es.marketing as Catalog).compare as Catalog]
];

/**
 * Copy every templated comparison page reads. A missing key is a runtime
 * throw on a public marketing page, and the dynamic `row${n}` / `faq${n}`
 * lookups are invisible to the static i18n key-usage guard, so they are
 * pinned here instead.
 */
function requiredKeys(bespoke: boolean): string[] {
  if (bespoke) return ["name", "teaser"];
  const rows = Array.from({ length: COMPARE_ROW_COUNT }, (_, i) => i + 1).flatMap((n) => [
    `row${n}.label`,
    `row${n}.us`,
    `row${n}.them`
  ]);
  const faq = [1, 2, 3].flatMap((n) => [`faq${n}.q`, `faq${n}.a`]);
  return [
    "name",
    "teaser",
    "metaTitle",
    "metaDescription",
    "ogTitle",
    "ogDescription",
    "heroEyebrow",
    "heroTitle",
    "heroHighlight",
    "heroSubtitle",
    "themColumn",
    "themCardTitle",
    "themCard1",
    "themCard2",
    "themCard3",
    "usCardTitle",
    "usCard1",
    "usCard2",
    "usCard3",
    "ctaTitle",
    "ctaSubtitle",
    ...rows,
    ...faq
  ];
}

function lookup(root: Catalog, dotted: string): unknown {
  let node: unknown = root;
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe("comparison registry", () => {
  it("has a unique slug and i18n key per entry", () => {
    expect(new Set(COMPARISONS.map((c) => c.slug)).size).toBe(COMPARISONS.length);
    expect(new Set(COMPARISONS.map((c) => c.i18nKey)).size).toBe(COMPARISONS.length);
  });

  it("gives every entry a verdict for each row", () => {
    for (const entry of COMPARISONS) {
      expect(entry.verdicts).toHaveLength(COMPARE_ROW_COUNT);
      for (const verdict of entry.verdicts) {
        expect(["us", "them", "tie"]).toContain(verdict);
      }
    }
  });

  it("concedes at least one row somewhere, since a clean sweep reads as marketing", () => {
    // An assistant that cross-checks a comparison page against the vendor's
    // own site and finds it one-sided stops citing it. Conceding is the point.
    const conceded = COMPARISONS.filter((c) => c.verdicts.some((v) => v !== "us"));
    expect(conceded.length).toBe(COMPARISONS.length);
  });

  it("keeps the GoHighLevel page bespoke, so its existing URL keeps its own layout", () => {
    expect(getComparison("gohighlevel")?.bespoke).toBe(true);
    expect(getComparison("zinng")?.bespoke).toBeUndefined();
    expect(getComparison("nope")).toBeUndefined();
  });
});

describe.each(CATALOGS)("comparison copy (%s)", (_locale, compare) => {
  it.each(COMPARISONS.map((c) => [c.i18nKey, c] as const))(
    "%s has every key its page renders",
    (i18nKey, entry) => {
      const node = compare[i18nKey] as Catalog | undefined;
      expect(node, `marketing.compare.${i18nKey} missing`).toBeTruthy();
      for (const key of requiredKeys(Boolean(entry.bespoke))) {
        const value = lookup(node as Catalog, key);
        expect(typeof value, `marketing.compare.${i18nKey}.${key}`).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  );

  it("never uses the banned product label or an em dash", () => {
    const serialized = JSON.stringify(compare);
    expect(serialized.toLowerCase()).not.toContain("ai receptionist");
    expect(serialized).not.toContain("\u2014");
  });
});

describe("competitor claims", () => {
  it("carries the sourcing note that keeps figures honest", () => {
    const page = (en.marketing as Catalog).comparePage as Record<string, string>;
    // The note is shared by every entry, so it has to name every month any
    // entry was sourced in: July 2026 for the first four, August 2026 for
    // Follow Up Boss. Adding an entry sourced later means widening this.
    expect(page.tableSubtitle).toContain("July and August 2026");
    expect(page.sourcedNote).toContain("July and August 2026");
    expect(page.sourcedNote).toContain("{name}");
  });
});
