import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_URL, siteUrl } from "@/lib/marketing/site-url";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

/**
 * Doc comments may name the origin when documenting a parameter; what must
 * not reappear is a hardcoded origin in CODE, which is how the site ended up
 * declaring the apex canonical in six files while the blog pages quietly
 * used www.
 */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

describe("SITE_URL", () => {
  it("is the host that actually serves the site", () => {
    // The apex 307s every path to www, so declaring the apex canonical
    // pointed every canonical tag, og:url, and sitemap entry at a redirect.
    expect(SITE_URL).toBe("https://www.newcoworker.com");
    expect(SITE_URL.endsWith("/")).toBe(false);
  });

  it("builds absolute URLs without doubling the slash on root", () => {
    expect(siteUrl("/")).toBe(SITE_URL);
    expect(siteUrl("/pricing")).toBe(`${SITE_URL}/pricing`);
  });

  it("is the only place in src/ that hardcodes the public origin", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file);
      if (rel === "src/lib/marketing/site-url.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (isComment(line)) continue;
        if (/https:\/\/(www\.)?newcoworker\.com/.test(line)) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }
    expect(
      offenders,
      "Import SITE_URL from @/lib/marketing/site-url instead of hardcoding the origin"
    ).toEqual([]);
  });
});
