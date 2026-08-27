/**
 * The root layout (src/app/layout.tsx) sets
 *   title: { default: "New Coworker", template: "%s | New Coworker" }
 * so Next.js appends " | New Coworker" to every page `title` on its own. A
 * page that ships its own brand suffix therefore renders it twice, in the
 * browser tab and in the search result: "Blog | New Coworker | New Coworker".
 *
 * The same layout sets `openGraph.title` and `twitter.title` as PLAIN
 * STRINGS, not template objects. Next.js does not template those, so og and
 * twitter titles legitimately carry the brand themselves. That asymmetry is
 * why this test distinguishes the page `title` field from its og/twitter
 * siblings instead of blanket-stripping the brand everywhere.
 *
 * Source-level assertions, matching i18n-key-usage.test.ts: these are async
 * server components, so their metadata is cheaper to verify by reading it
 * than by standing up a render harness.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import es from "../messages/es.json";

const ROOT = join(__dirname, "..");
const APP = join(ROOT, "src/app");

/**
 * Matches a trailing brand suffix: "| New Coworker", "- New Coworker", and the
 * dash variants. The dashes are escaped rather than typed, since the repo bans
 * a literal em dash in every file including this one.
 */
const BRAND_SUFFIX = /[|\-\u2013\u2014:]\s*New Coworker\s*$/;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(path);
    else if (/^(page|layout)\.tsx$/.test(entry.name)) yield path;
  }
}

/**
 * Drops comments so prose about titles is never parsed as one. Only whole
 * comment lines are removed, which leaves `https://` inside string values
 * intact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** Returns the balanced `{...}` slice starting at the brace at `open`. */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces at ${open}`);
}

/** Removes nested `openGraph`/`twitter`/`alternates` objects from a block. */
function stripNested(block: string): string {
  let out = block;
  for (const key of ["openGraph", "twitter", "alternates", "robots", "icons"]) {
    for (;;) {
      const at = out.search(new RegExp(`\\b${key}\\s*:\\s*\\{`));
      if (at === -1) break;
      const open = out.indexOf("{", at);
      out = out.slice(0, at) + out.slice(open + braceBlock(out, open).length);
    }
  }
  return out;
}

/** Every metadata object literal in a file: `export const metadata` + returns. */
function metadataBlocks(src: string): string[] {
  const blocks: string[] = [];
  const constAt = src.search(/export const metadata\s*:\s*Metadata\s*=\s*\{/);
  if (constAt !== -1) blocks.push(braceBlock(src, src.indexOf("{", constAt)));

  // Scope `return {` scanning to generateMetadata, so unrelated helpers that
  // build objects with a `title` (FAQ groups, feature cards) stay out.
  const fnAt = src.search(/(export )?async function generateMetadata/);
  if (fnAt !== -1) {
    const body = braceBlock(src, src.indexOf("{", src.indexOf("Promise<Metadata>", fnAt)));
    const returns = [...body.matchAll(/\breturn\s*\{/g)];
    for (const m of returns) blocks.push(braceBlock(body, body.indexOf("{", m.index)));
  }
  return blocks;
}

/**
 * Maps translator variables to their namespace. A namespace built from a
 * template literal (`marketing.compare.${entry.i18nKey}`) cannot be resolved
 * statically, so it is recorded as its literal prefix plus a `*` marker and
 * expanded over every child of that prefix at lookup time.
 */
function translatorNamespaces(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const quoted = /const\s+(\w+)\s*=\s*await\s+getTranslations\(\s*"([^"]+)"\s*\)/g;
  for (const m of src.matchAll(quoted)) map.set(m[1], m[2]);
  const templated = /const\s+(\w+)\s*=\s*await\s+getTranslations\(\s*`([^`$]*)\$\{/g;
  for (const m of src.matchAll(templated)) map.set(m[1], `${m[2].replace(/\.$/, "")}.*`);
  return map;
}

/** Expands a `prefix.*` namespace into one key per child that defines `leaf`. */
function expandKey(dotted: string): string[] {
  if (!dotted.includes(".*.")) return [dotted];
  const [prefix, leaf] = dotted.split(".*.");
  const parent = lookup(en, prefix);
  if (!parent || typeof parent !== "object") return [];
  return Object.keys(parent)
    .filter((child) => typeof lookup(en, `${prefix}.${child}.${leaf}`) === "string")
    .map((child) => `${prefix}.${child}.${leaf}`);
}

/** Reads the value of `title:` in an object literal, comma- and depth-aware. */
function titleExpression(block: string): string | undefined {
  const at = block.search(/(?<![\w.])title\s*:/);
  if (at === -1) return undefined;
  let i = block.indexOf(":", at) + 1;
  let depth = 0;
  let out = "";
  for (; i < block.length; i++) {
    const ch = block[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

function lookup(catalog: unknown, dotted: string): unknown {
  let node = catalog;
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

type PageTitle = { file: string; expression: string; catalogKeys: string[] };

/** The `title:` field of every page metadata object across the app router. */
function collectPageTitles(): PageTitle[] {
  const found: PageTitle[] = [];
  for (const file of walkSourceFiles(APP)) {
    const src = stripComments(readFileSync(file, "utf8"));
    if (!/export const metadata|generateMetadata/.test(src)) continue;
    const rel = relative(ROOT, file);
    const namespaces = translatorNamespaces(src);

    // The root layout owns the template itself, so its brand is the source.
    if (rel === "src/app/layout.tsx") continue;

    for (const block of metadataBlocks(src)) {
      const expression = titleExpression(stripNested(block));
      if (!expression) continue;
      const call = expression.match(/^(\w+)\(\s*"([^"]+)"/);
      const ns = call ? namespaces.get(call[1]) : undefined;
      found.push({
        file: rel,
        expression,
        catalogKeys: call && ns ? expandKey(`${ns}.${call[2]}`) : []
      });
    }
  }
  return found;
}

const PAGE_TITLES = collectPageTitles();

/**
 * Every catalog key this app router feeds to a page `title`. Pinned so a page
 * that silently drops its title (and with it this test's coverage of that key)
 * shows up as a diff rather than as quietly reduced coverage.
 */
const PAGE_TITLE_KEYS = [
  "bookingPage.manageMetaTitle",
  "bookingPage.metaTitle",
  "marketing.about.metaTitle",
  "marketing.blogPage.metaTitle",
  "marketing.chatgptPage.metaTitle",
  "marketing.compare.answeringService.metaTitle",
  "marketing.compare.followUpBoss.metaTitle",
  "marketing.compare.marblism.metaTitle",
  "marketing.compare.smithAi.metaTitle",
  "marketing.compare.zinng.metaTitle",
  "marketing.compareGhl.metaTitle",
  "marketing.comparePage.metaTitle",
  "marketing.contactPage.metaTitle",
  "marketing.faqPage.metaTitle",
  "marketing.featuresPage.metaTitle",
  "marketing.industriesPage.detailMetaTitle",
  "marketing.industriesPage.metaTitle",
  "marketing.integrationsPage.metaTitle",
  "marketing.onboard.metaTitle",
  "marketing.pricing.metaTitle",
  "marketing.securityPage.metaTitle",
  "marketing.slackPage.metaTitle",
  "marketing.zoomPage.metaTitle"
];

describe("page title brand suffix", () => {
  it("finds a title on the metadata-bearing pages", () => {
    expect(PAGE_TITLES.length).toBeGreaterThanOrEqual(15);
  });

  it("no page builds the brand into its own title expression", () => {
    const offenders = PAGE_TITLES.filter((t) => /New Coworker/.test(t.expression)).map(
      (t) => `${t.file}: ${t.expression}`
    );
    expect(offenders).toEqual([]);
  });

  it("no catalog key used as a page title ends with the brand suffix", () => {
    const offenders: string[] = [];
    for (const { file, catalogKeys } of PAGE_TITLES) {
      for (const catalogKey of catalogKeys) {
        for (const [locale, catalog] of [
          ["en", en],
          ["es", es]
        ] as const) {
          const value = lookup(catalog, catalogKey);
          if (typeof value !== "string") {
            offenders.push(`${file}: ${catalogKey} missing from ${locale}.json`);
          } else if (BRAND_SUFFIX.test(value)) {
            offenders.push(`${locale}.json ${catalogKey} = "${value}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still routes every known page-title key through this check", () => {
    const scanned = [...new Set(PAGE_TITLES.flatMap((t) => t.catalogKeys))].sort();
    expect(scanned).toEqual(PAGE_TITLE_KEYS);
  });

  it("keeps the brand on og and twitter titles, which Next.js never templates", () => {
    // Guards the other direction: stripping the brand from these would ship
    // unbranded social cards, since the root layout's openGraph.title is a
    // plain string rather than a template.
    for (const key of ["marketing.blogPage.ogTitle", "marketing.onboard.ogTitle"]) {
      for (const catalog of [en, es]) {
        expect(lookup(catalog, key)).toMatch(/\|\s*New Coworker$/);
      }
    }
  });
});
