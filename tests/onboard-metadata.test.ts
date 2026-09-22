/**
 * /onboard is a public signup page (sitemap priority 0.9, Spanish mirror,
 * linked from nav, footer, and llms.txt). The SEO audit found it indexed
 * with no canonical and no og:image. That is a metadata bug, not a product
 * decision to hide the page: sibling marketing pages self-canonical via
 * esAlternatesForRequest and ship a route-level opengraph-image.tsx.
 *
 * Do not noindex this URL, and do not canonical it at /pricing. /onboard is
 * the signup surface; /pricing is the comparison surface. They share plan
 * cards, they are not duplicates.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock()
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `t:${key}`),
  getLocale: vi.fn(async () => "en"),
  getMessages: vi.fn(async () => ({}))
}));

import { generateMetadata } from "@/app/onboard/layout";

const ROOT = join(__dirname, "..");
const ONBOARD_DIR = join(ROOT, "src/app/onboard");
const OG_IMAGE = join(ONBOARD_DIR, "opengraph-image.tsx");
const TWITTER_IMAGE = join(ONBOARD_DIR, "twitter-image.tsx");

function pathnameHeaders(pathname: string) {
  return {
    get: (name: string) => (name === "x-pathname" ? pathname : null)
  };
}

describe("/onboard generateMetadata", () => {
  beforeEach(() => {
    headersMock.mockReset();
  });

  it("self-canonicals English /onboard and sets matching og:url", async () => {
    headersMock.mockResolvedValue(pathnameHeaders("/onboard"));
    const meta = await generateMetadata();
    expect(meta.alternates).toMatchObject({
      canonical: "/onboard",
      languages: {
        en: "/onboard",
        es: "/es/onboard",
        "x-default": "/onboard"
      }
    });
    expect(meta.openGraph?.url).toBe("/onboard");
    expect(meta.alternates?.canonical).not.toBe("/pricing");
    expect(meta.openGraph?.url).not.toBe("/pricing");
  });

  it("self-canonicals Spanish /es/onboard from x-pathname, ignoring cookies", async () => {
    headersMock.mockResolvedValue(pathnameHeaders("/es/onboard"));
    const meta = await generateMetadata();
    expect(meta.alternates?.canonical).toBe("/es/onboard");
    expect(meta.openGraph?.url).toBe("/es/onboard");
  });

  it("keeps a large Twitter card and does not noindex a sitemap URL", async () => {
    headersMock.mockResolvedValue(pathnameHeaders("/onboard"));
    const meta = await generateMetadata();
    const twitter = meta.twitter;
    expect(twitter && "card" in twitter ? twitter.card : undefined).toBe(
      "summary_large_image"
    );
    expect(meta.robots).not.toEqual(expect.objectContaining({ index: false }));
    if (typeof meta.robots === "object" && meta.robots) {
      expect(meta.robots.index).not.toBe(false);
    }
  });
});

describe("/onboard social card files", () => {
  it("ships a route-level opengraph-image so generateMetadata cannot wipe the root card", () => {
    // A child generateMetadata that sets openGraph without images overwrites
    // the root layout's og:image. Sibling marketing pages (pricing, contact,
    // faq) put opengraph-image.tsx next to the page so Next injects a card
    // for this segment. /onboard was the gap the audit crawled.
    expect(existsSync(OG_IMAGE), "src/app/onboard/opengraph-image.tsx").toBe(true);
    const src = readFileSync(OG_IMAGE, "utf8");
    expect(src).toContain("renderMarketingOg");
    expect(src).toMatch(/export const alt\s*=/);
    expect(src).toMatch(/export const size\s*=/);
    expect(src).toMatch(/export const contentType\s*=/);
  });

  it("re-exports that card as twitter-image, matching sibling marketing pages", () => {
    expect(existsSync(TWITTER_IMAGE), "src/app/onboard/twitter-image.tsx").toBe(true);
    const src = readFileSync(TWITTER_IMAGE, "utf8");
    expect(src).toContain('from "./opengraph-image"');
    expect(src).toMatch(/export default OpenGraphImage/);
  });
});
