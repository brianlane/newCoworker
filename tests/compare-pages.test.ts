import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import {
  type CompareDef,
  COMPARISONS,
  DEFAULT_CARD_BULLETS,
  DEFAULT_FAQ_COUNT,
  getComparison
} from "../src/app/(marketing)/compare/data";

type Catalog = Record<string, unknown>;

const CATALOGS: [string, Catalog][] = [
  ["en", (en.marketing as Catalog).compare as Catalog],
  ["es", (es.marketing as Catalog).compare as Catalog]
];

function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * Copy every templated comparison page reads, derived from the entry's own
 * declared counts (rows from verdicts.length, faqCount, cardBullets, the
 * stat band, the reviews note). A missing key is a runtime throw on a public
 * marketing page, and the dynamic `row${n}` / `faq${n}` lookups are
 * invisible to the static i18n key-usage guard, so they are pinned here
 * instead.
 */
function requiredKeys(entry: CompareDef): string[] {
  const rows = oneTo(entry.verdicts.length).flatMap((n) => [
    `row${n}.label`,
    `row${n}.us`,
    `row${n}.them`
  ]);
  const faq = oneTo(entry.faqCount ?? DEFAULT_FAQ_COUNT).flatMap((n) => [
    `faq${n}.q`,
    `faq${n}.a`
  ]);
  const cards = oneTo(entry.cardBullets ?? DEFAULT_CARD_BULLETS).flatMap((n) => [
    `themCard${n}`,
    `usCard${n}`
  ]);
  const stats = entry.statBand
    ? oneTo(4).flatMap((n) => [`stat${n}Value`, `stat${n}Label`])
    : [];
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
    "usCardTitle",
    "ctaTitle",
    "ctaSubtitle",
    ...(entry.reviewsNote ? ["reviewsNote"] : []),
    ...stats,
    ...cards,
    ...rows,
    ...faq
  ];
}

/**
 * Keys just past each declared count. Their absence keeps the declaration
 * honest in both directions: a verdict added without copy fails the check
 * above, and copy added without widening the declaration fails this one
 * (it would otherwise sit in the catalog unrendered).
 */
function forbiddenKeys(entry: CompareDef): string[] {
  return [
    `row${entry.verdicts.length + 1}`,
    `faq${(entry.faqCount ?? DEFAULT_FAQ_COUNT) + 1}`,
    `themCard${(entry.cardBullets ?? DEFAULT_CARD_BULLETS) + 1}`,
    `usCard${(entry.cardBullets ?? DEFAULT_CARD_BULLETS) + 1}`,
    ...(entry.statBand ? [] : ["stat1Value"]),
    ...(entry.reviewsNote ? [] : ["reviewsNote"])
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

  it("gives every entry at least one row of valid verdicts", () => {
    for (const entry of COMPARISONS) {
      expect(entry.verdicts.length).toBeGreaterThan(0);
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

  it("renders GoHighLevel through the template with its full bespoke-era content", () => {
    // The hand-built page this entry replaced carried 10 rows, 5 FAQs, four
    // bullets per card, the stat band, and the reviews note. Shrinking any
    // of these would silently drop published claims from /compare/gohighlevel.
    const ghl = getComparison("gohighlevel");
    expect(ghl?.verdicts).toHaveLength(10);
    expect(ghl?.faqCount).toBe(5);
    expect(ghl?.cardBullets).toBe(4);
    expect(ghl?.statBand).toBe(true);
    expect(ghl?.reviewsNote).toBe(true);
    expect(getComparison("nope")).toBeUndefined();
  });
});

describe.each(CATALOGS)("comparison copy (%s)", (_locale, compare) => {
  it.each(COMPARISONS.map((c) => [c.i18nKey, c] as const))(
    "%s has every key its page renders",
    (i18nKey, entry) => {
      const node = compare[i18nKey] as Catalog | undefined;
      expect(node, `marketing.compare.${i18nKey} missing`).toBeTruthy();
      for (const key of requiredKeys(entry)) {
        const value = lookup(node as Catalog, key);
        expect(typeof value, `marketing.compare.${i18nKey}.${key}`).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  );

  it.each(COMPARISONS.map((c) => [c.i18nKey, c] as const))(
    "%s declares counts matching its catalog copy",
    (i18nKey, entry) => {
      const node = compare[i18nKey] as Catalog;
      for (const key of forbiddenKeys(entry)) {
        expect(
          lookup(node, key),
          `marketing.compare.${i18nKey}.${key} exists but the entry never renders it`
        ).toBeUndefined();
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
