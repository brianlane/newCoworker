/**
 * Internal links from marketing hubs to the SEO pillar pages.
 *
 * The destination pages may land in a parallel PR. This suite still requires
 * the hrefs on the shared footer (rendered on home, features, industries,
 * and compare) so crawlers can find the pillars without rewriting frozen
 * homepage or industry body paragraphs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";
import { sitemapPathsFor, SPANISH_MARKETING_PREFIXES } from "@/lib/i18n/es-routes";

const ROOT = join(import.meta.dirname, "..");
const FOOTER = readFileSync(
  join(ROOT, "src/components/marketing/MarketingFooter.tsx"),
  "utf8"
);
const HOME = readFileSync(join(ROOT, "src/app/(marketing)/page.tsx"), "utf8");
const INDUSTRY_PAGE = readFileSync(
  join(ROOT, "src/app/(marketing)/industries/[slug]/page.tsx"),
  "utf8"
);

const SEO_PILLAR_HREFS = [
  "/ai-receptionist",
  "/ai-answering-service",
  "/after-hours-answering"
] as const;

function footerHrefToLabelKey(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\{\s*href:\s*"([^"]+)"\s*,\s*labelKey:\s*"([^"]+)"/g;
  for (const match of source.matchAll(re)) {
    map.set(match[1], match[2]);
  }
  return map;
}

describe("SEO pillar internal links", () => {
  it("the marketing footer lists hrefs to the three pillars", () => {
    const hrefs = footerHrefToLabelKey(FOOTER);
    for (const href of SEO_PILLAR_HREFS) {
      expect(hrefs.has(href), `footer missing href ${href}`).toBe(true);
    }
  });

  it("pillar link labels are coworker-voiced, not an AI receptionist product name", () => {
    const hrefs = footerHrefToLabelKey(FOOTER);
    const enNav = en.marketing.nav as Record<string, string>;
    const esNav = es.marketing.nav as Record<string, string>;
    for (const href of SEO_PILLAR_HREFS) {
      const labelKey = hrefs.get(href);
      expect(labelKey, `footer labelKey for ${href}`).toBeTruthy();
      const enLabel = enNav[labelKey!];
      const esLabel = esNav[labelKey!];
      expect(enLabel, `en marketing.nav.${labelKey}`).toBeTruthy();
      expect(esLabel, `es marketing.nav.${labelKey}`).toBeTruthy();
      expect(enLabel.toLowerCase()).not.toContain("receptionist");
      expect(esLabel.toLowerCase()).not.toContain("receptionist");
    }
  });

  it("the Spanish marketing mirror list includes each pillar path", () => {
    for (const href of SEO_PILLAR_HREFS) {
      expect(SPANISH_MARKETING_PREFIXES).toContain(href);
      expect(sitemapPathsFor(href)).toEqual([href, `/es${href}`]);
    }
  });

  it("does not shoehorn pillar hrefs into frozen homepage or industry body copy", () => {
    for (const href of SEO_PILLAR_HREFS) {
      expect(HOME).not.toContain(href);
      expect(INDUSTRY_PAGE).not.toContain(href);
    }
  });
});
