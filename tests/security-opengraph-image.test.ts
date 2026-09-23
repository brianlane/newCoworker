/**
 * The 2026-09-22 SEO audit parsed `/security` with OG image None. Twitter
 * then inherited the root layout's `/twitter-image`, which is the generic
 * homepage card.
 *
 * Cause: a page-level `openGraph` object in generateMetadata replaces the
 * whole inherited Open Graph object (layout images included). Next.js only
 * keeps an og:image that lives in the page's own segment: a colocated
 * `opengraph-image.tsx`, or an explicit non-homepage `images` entry.
 * Contact, FAQ, About, and the GoHighLevel compare page already do this.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SECURITY_DIR = join(ROOT, "src/app/(marketing)/security");
const SECURITY_PAGE = join(SECURITY_DIR, "page.tsx");
const SECURITY_OG = join(SECURITY_DIR, "opengraph-image.tsx");
const SECURITY_TWITTER = join(SECURITY_DIR, "twitter-image.tsx");
const HOMEPAGE_OG = join(ROOT, "src/app/opengraph-image.tsx");

const HOMEPAGE_SLOGAN = "Your AI employee that never sleeps";
const SECURITY_HERO = "Security a reviewer can verify";

describe("/security social preview", () => {
  it("ships a page-specific opengraph-image, not the homepage generic card", () => {
    expect(
      existsSync(SECURITY_OG),
      "colocate opengraph-image.tsx on the /security route"
    ).toBe(true);

    const og = readFileSync(SECURITY_OG, "utf8");
    const home = readFileSync(HOMEPAGE_OG, "utf8");

    expect(og).toMatch(/renderMarketingOg/);
    expect(og).toMatch(/eyebrow:\s*"Security"/);
    expect(og).toContain(SECURITY_HERO);
    expect(og).not.toContain(HOMEPAGE_SLOGAN);
    expect(og).not.toMatch(/from ["']\.\.\/\.\.\/opengraph-image["']/);
    expect(og).not.toEqual(home);
  });

  it("mirrors that card as twitter-image so Twitter does not inherit /twitter-image", () => {
    expect(
      existsSync(SECURITY_TWITTER),
      "colocate twitter-image.tsx on the /security route"
    ).toBe(true);

    const twitter = readFileSync(SECURITY_TWITTER, "utf8");
    expect(twitter).toMatch(/from ["']\.\/opengraph-image["']/);
    expect(twitter).toMatch(/export default OpenGraphImage/);
  });

  it("does not pin generateMetadata images to the homepage generic paths", () => {
    const page = readFileSync(SECURITY_PAGE, "utf8");
    expect(page).toMatch(/openGraph:\s*\{/);
    expect(page).not.toMatch(/images:\s*\[["']\/opengraph-image["']\]/);
    expect(page).not.toMatch(/images:\s*\[["']\/twitter-image["']\]/);
  });
});
