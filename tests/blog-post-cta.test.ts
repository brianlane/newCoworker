/**
 * The blog post page was the only marketing surface without the shared
 * CtaBanner: a reader could finish a post and never be asked to try the
 * product, since the only signup paths were the top nav (long since
 * scrolled past) and one footer link. These assertions pin the banner in
 * place AND pin its reading position, because position is the whole point:
 * a CTA rendered below the share row and the subscribe box is the third
 * ask, not the first.
 *
 * Source-level assertions, matching blog-isr-config.test.ts: the page is an
 * async server component wired to next-intl, so its structure is cheaper to
 * verify by reading it than by standing up a render harness.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";

const ROOT = join(import.meta.dirname, "..");
const POST_PAGE = readFileSync(join(ROOT, "src/app/blog/[slug]/page.tsx"), "utf8");

const CTA_KEYS = ["ctaTitle", "ctaSubtitle", "ctaLabel"] as const;

describe("blog post CTA", () => {
  it("renders the shared CtaBanner pointing at the signup route", () => {
    expect(POST_PAGE).toMatch(/import \{ CtaBanner \} from "@\/components\/marketing\/sections"/);
    expect(POST_PAGE).toMatch(/<CtaBanner/);
    expect(POST_PAGE).toMatch(/ctaHref="\/onboard"/);
  });

  it("wires the banner to the blogPage cta keys", () => {
    for (const key of CTA_KEYS) {
      expect(POST_PAGE, key).toContain(`t("${key}")`);
    }
  });

  it("places the CTA before the share and subscribe asks", () => {
    const cta = POST_PAGE.indexOf("<CtaBanner");
    const share = POST_PAGE.indexOf('t("sharePost")');
    const subscribe = POST_PAGE.indexOf('t("subscribeTitle")');

    expect(cta).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(-1);
    expect(subscribe).toBeGreaterThan(-1);
    expect(cta).toBeLessThan(share);
    expect(cta).toBeLessThan(subscribe);
  });

  it("keeps the CTA outside <article>, which holds post content only", () => {
    const articleClose = POST_PAGE.indexOf("</article>");
    const cta = POST_PAGE.indexOf("<CtaBanner");

    expect(articleClose).toBeGreaterThan(-1);
    // Nesting CtaBanner inside <article> would also double the max-w-3xl
    // px-6 wrapper and render the card inset from the text above it.
    expect(cta).toBeGreaterThan(articleClose);
  });

  it("carries non-empty CTA copy in both catalogs", () => {
    for (const [locale, catalog] of [
      ["en", en],
      ["es", es]
    ] as const) {
      const page = catalog.marketing.blogPage as Record<string, unknown>;
      for (const key of CTA_KEYS) {
        const value = page[key];
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect((value as string).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same signup wording as the nav button in each locale", () => {
    expect(en.marketing.blogPage.ctaLabel).toBe(en.marketing.nav.getStarted);
    expect(es.marketing.blogPage.ctaLabel).toBe(es.marketing.nav.getStarted);
  });
});
