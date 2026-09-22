/**
 * Homepage SEO metadata (title / meta / OG) vs frozen visible copy.
 *
 * Buyer search terms (AI receptionist, 24/7 answering, booking) belong in
 * metadata only. Visible H1 and body stay "AI employee" / "AI coworker".
 * Source-level on generateMetadata, matching metadata-brand-suffix.test.ts:
 * the homepage is an async server component, cheaper to read than to render.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";

const ROOT = join(__dirname, "..");
const HOME_PAGE = join(ROOT, "src/app/(marketing)/page.tsx");

const METADATA_KEYS = [
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription"
] as const;

const VISIBLE_HOME_KEYS = [
  "heroTitle",
  "heroHighlight",
  "heroSubtitle",
  "startFor",
  "seePricing",
  "comparePlans",
  "tryNow",
  "callDemoTitle",
  "callDemoBody",
  "featuresTitle",
  "featuresHighlight",
  "featuresSubtitle",
  "howEyebrow",
  "howTitle",
  "howSubtitle",
  "privacyEyebrow",
  "privacyTitle",
  "privacyBody",
  "plansFrom",
  "plansTeaser",
  "ctaTitle",
  "ctaSubtitle",
  "ctaLabel"
] as const;

/** sha256 of `key=value` lines for VISIBLE_HOME_KEYS. Bump only with a copy freeze. */
const FROZEN_VISIBLE_EN =
  "b200d27bed37ebd85cfde81a8e543c497c11ce6bb21bfab603bcd1833b1daf89";
const FROZEN_VISIBLE_ES =
  "361abf50ea17fe492f2efa8db203da4595eb358f83bb6ed99ffd53bc9a21743d";

type HomeCatalog = Record<string, string>;

function homeOf(catalog: { marketing: { home: Record<string, string> } }): HomeCatalog {
  return catalog.marketing.home;
}

function visibleFingerprint(home: HomeCatalog): string {
  return createHash("sha256")
    .update(VISIBLE_HOME_KEYS.map((key) => `${key}=${home[key]}`).join("\n"))
    .digest("hex");
}

const brand = en.marketing.nav.brand;
const enHome = homeOf(en);
const esHome = homeOf(es);
const homePageSrc = readFileSync(HOME_PAGE, "utf8");

describe("homepage generateMetadata wires title and social tags", () => {
  it("sets the document title from marketing.home.metaTitle", () => {
    expect(homePageSrc).toMatch(/title:\s*t\("metaTitle"\)/);
  });

  it("still feeds description, og, and twitter from the home catalog", () => {
    expect(homePageSrc).toMatch(/description:\s*t\("metaDescription"\)/);
    expect(homePageSrc).toMatch(/title:\s*t\("ogTitle"\)/);
    expect(homePageSrc).toMatch(/description:\s*t\("ogDescription"\)/);
  });

  it("renders the visible H1 from heroTitle + heroHighlight, not from metaTitle", () => {
    expect(homePageSrc).toContain('t("home.heroTitle")');
    expect(homePageSrc).toContain('t("home.heroHighlight")');
    expect(homePageSrc).not.toMatch(/PageHero[\s\S]*t\("home\.metaTitle"\)/);
  });
});

describe("homepage visible copy stays frozen", () => {
  it("keeps the English H1 as the AI employee slogan", () => {
    expect(`${enHome.heroTitle} ${enHome.heroHighlight}`).toBe(
      "Your AI employee that never sleeps"
    );
  });

  it("keeps the Spanish H1 as the matching employee slogan", () => {
    expect(`${esHome.heroTitle} ${esHome.heroHighlight}`).toBe(
      "Tu empleado de IA que nunca duerme"
    );
  });

  it("does not rewrite English visible homepage strings", () => {
    expect(visibleFingerprint(enHome)).toBe(FROZEN_VISIBLE_EN);
  });

  it("does not rewrite Spanish visible homepage strings", () => {
    expect(visibleFingerprint(esHome)).toBe(FROZEN_VISIBLE_ES);
  });

  it("keeps receptionist-as-product out of visible home copy", () => {
    for (const home of [enHome, esHome]) {
      for (const key of VISIBLE_HOME_KEYS) {
        expect(home[key].toLowerCase(), key).not.toContain("ai receptionist");
        expect(home[key].toLowerCase(), key).not.toContain("recepcionista de ia");
      }
    }
  });
});

describe("homepage metadata targets receptionist and answering intent", () => {
  it("defines the four metadata keys in both catalogs", () => {
    for (const key of METADATA_KEYS) {
      expect(enHome[key], `en ${key}`).toEqual(expect.any(String));
      expect(esHome[key], `es ${key}`).toEqual(expect.any(String));
      expect(enHome[key].trim().length, `en ${key}`).toBeGreaterThan(10);
      expect(esHome[key].trim().length, `es ${key}`).toBeGreaterThan(10);
    }
  });

  it("keeps the English document title keyword-rich and within ~60 chars once branded", () => {
    expect(enHome.metaTitle.toLowerCase()).toContain("ai receptionist");
    expect(enHome.metaTitle.toLowerCase()).toContain("24/7");
    expect(enHome.metaTitle.toLowerCase()).toMatch(/answer/);
    expect(enHome.metaTitle).not.toMatch(new RegExp(`[|:\\-]\\s*${brand}\\s*$`));
    const rendered = `${enHome.metaTitle} | ${brand}`;
    expect(rendered.length, rendered).toBeLessThanOrEqual(60);
  });

  it("enriches the English meta description with receptionist, answering, and booking", () => {
    const d = enHome.metaDescription.toLowerCase();
    expect(d).toContain("ai receptionist");
    expect(d).toMatch(/24\/7|around the clock/);
    expect(d).toMatch(/answer/);
    expect(d).toMatch(/book/);
    expect(enHome.metaDescription).toContain(brand);
  });

  it("mirrors the English SEO title on OG and Twitter", () => {
    expect(enHome.ogTitle.toLowerCase()).toContain("ai receptionist");
    expect(enHome.ogTitle.toLowerCase()).toContain("24/7");
    expect(enHome.ogTitle).toMatch(new RegExp(`\\|\\s*${brand}$`));
    expect(enHome.ogDescription.toLowerCase()).toContain("ai receptionist");
    expect(enHome.ogDescription.toLowerCase()).toMatch(/answer|book/);
  });

  it("keeps Spanish metadata on recepcionista / contestación / 24/7", () => {
    expect(esHome.metaTitle.toLowerCase()).toContain("recepcionista");
    expect(esHome.metaTitle.toLowerCase()).toContain("24/7");
    expect(esHome.metaTitle.toLowerCase()).toMatch(/contestaci/);
    expect(esHome.metaTitle).not.toMatch(new RegExp(`[|:\\-]\\s*${brand}\\s*$`));
    const rendered = `${esHome.metaTitle} | ${brand}`;
    expect(rendered.length, rendered).toBeLessThanOrEqual(60);

    const d = esHome.metaDescription.toLowerCase();
    expect(d).toContain("recepcionista");
    expect(d).toMatch(/contestaci|llamadas/);
    expect(d).toMatch(/cita/);
    expect(esHome.metaDescription).toContain(brand);

    expect(esHome.ogTitle.toLowerCase()).toContain("recepcionista");
    expect(esHome.ogTitle).toMatch(new RegExp(`\\|\\s*${brand}$`));
    expect(esHome.ogDescription.toLowerCase()).toContain("recepcionista");
  });

  it("does not reuse the visible H1 as the document title", () => {
    expect(enHome.metaTitle).not.toBe(`${enHome.heroTitle} ${enHome.heroHighlight}`);
    expect(esHome.metaTitle).not.toBe(`${esHome.heroTitle} ${esHome.heroHighlight}`);
  });
});
