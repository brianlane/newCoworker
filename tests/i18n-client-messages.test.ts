/**
 * The route-to-namespace contract for client i18n messages
 * (src/i18n/client-messages.ts).
 *
 * Since the root layout stopped shipping the full catalog, a client component
 * can only translate namespaces its route's providers actually carry. Nothing
 * fails at build time when that contract breaks: the component just renders a
 * MISSING_MESSAGE error in production. So this suite makes the contract
 * static: it walks the real import graph from every route entry file, finds
 * every reachable "use client" component, extracts every useTranslations
 * namespace, and asserts the providers wrapping that route cover it.
 *
 * If this test fails, either add the namespace to the right section in
 * SECTION_CLIENT_MESSAGES, or stop importing the component into that section.
 * Do not widen a section to a whole top-level namespace without checking the
 * size cost; the point of the mapping is that pages ship kilobytes, not the
 * catalog.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  GLOBAL_CLIENT_MESSAGE_PATHS,
  SECTION_CLIENT_MESSAGES,
  pickMessages
} from "@/i18n/client-messages";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const APP = path.join(SRC, "app");

const EN = JSON.parse(readFileSync(path.join(ROOT, "messages/en.json"), "utf8"));
const ES = JSON.parse(readFileSync(path.join(ROOT, "messages/es.json"), "utf8"));

/** Route entry files Next renders inside the layout/provider chain. */
const ENTRY_NAMES = new Set([
  "page.tsx",
  "layout.tsx",
  "template.tsx",
  "error.tsx",
  "not-found.tsx",
  "loading.tsx"
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const sourceCache = new Map<string, string>();
function sourceOf(file: string): string {
  let src = sourceCache.get(file);
  if (src === undefined) {
    src = readFileSync(file, "utf8");
    sourceCache.set(file, src);
  }
  return src;
}

/**
 * "use client" must precede all code, though comments may precede it, so
 * looking for the directive on its own line near the top is exact enough.
 */
function isClientFile(file: string): boolean {
  return /^\s*(["'])use client\1;?\s*$/m.test(sourceOf(file).slice(0, 2000));
}

/** Import/re-export/dynamic-import specifiers in a file, resolved to paths. */
const importCache = new Map<string, string[]>();
function importsOf(file: string): string[] {
  let resolved = importCache.get(file);
  if (resolved !== undefined) return resolved;
  const src = sourceOf(file);
  const specs = new Set<string>();
  for (const re of [
    /from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /import\s+["']([^"']+)["']/g
  ]) {
    for (const m of src.matchAll(re)) specs.add(m[1]);
  }
  resolved = [];
  for (const spec of specs) {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = path.join(path.dirname(file), spec);
    else continue; // node_modules
    for (const candidate of [
      base,
      `${base}.tsx`,
      `${base}.ts`,
      path.join(base, "index.tsx"),
      path.join(base, "index.ts")
    ]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) {
        resolved.push(candidate);
        break;
      }
    }
  }
  importCache.set(file, resolved);
  return resolved;
}

/** All files transitively reachable from an entry, entry included. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const dep of importsOf(queue.pop() as string)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

function namespacesIn(file: string): string[] {
  return [...sourceOf(file).matchAll(/useTranslations\(\s*"([^"]+)"\s*\)/g)].map(
    (m) => m[1]
  );
}

/** Provider message paths in effect for a route entry file. */
function providerPathsFor(entry: string): string[] {
  const rel = path.relative(APP, entry).split(path.sep).join("/");
  const paths: string[] = [...GLOBAL_CLIENT_MESSAGE_PATHS];
  for (const section of Object.values(SECTION_CLIENT_MESSAGES)) {
    if (rel.startsWith(`${section.appDir}/`)) paths.push(...section.paths);
  }
  return paths;
}

/** A namespace is covered by a subset path equal to it or above it. */
function isCovered(ns: string, providerPaths: string[]): boolean {
  return providerPaths.some((p) => ns === p || ns.startsWith(`${p}.`));
}

function messageAt(catalog: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      catalog
    );
}

const allSrcFiles = walk(SRC);
const entryFiles = allSrcFiles.filter(
  (f) => f.startsWith(APP) && ENTRY_NAMES.has(path.basename(f))
);
const allConfiguredPaths = [
  ...GLOBAL_CLIENT_MESSAGE_PATHS,
  ...Object.values(SECTION_CLIENT_MESSAGES).flatMap((s) => [...s.paths])
];

describe("route/namespace contract", () => {
  it("found a plausible number of route entries and client components", () => {
    // Guards the guard: if the walker breaks (an fs or regex regression), it
    // would otherwise "pass" by scanning nothing.
    expect(entryFiles.length).toBeGreaterThan(50);
    expect(allSrcFiles.filter(isClientFile).length).toBeGreaterThan(100);
  });

  it("every reachable client useTranslations namespace is covered by its route's providers", () => {
    const failures: string[] = [];
    for (const entry of entryFiles) {
      const providerPaths = providerPathsFor(entry);
      for (const file of reachableFrom(entry)) {
        if (!isClientFile(file)) continue;
        for (const ns of namespacesIn(file)) {
          if (!isCovered(ns, providerPaths)) {
            failures.push(
              `${path.relative(ROOT, entry)} reaches ${path.relative(ROOT, file)} ` +
                `which uses "${ns}", not covered by [${providerPaths.join(", ")}]`
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("client components only call useTranslations with a string literal", () => {
    // A variable namespace would be invisible to the walk above, so it is
    // banned outright; same for useMessages, which needs the whole catalog.
    const offenders: string[] = [];
    for (const file of allSrcFiles) {
      if (!isClientFile(file)) continue;
      const src = sourceOf(file);
      if (/useTranslations\s*\(\s*(?!["')])/m.test(src)) {
        offenders.push(`${path.relative(ROOT, file)}: non-literal useTranslations arg`);
      }
      if (/useTranslations\s*\(\s*\)/m.test(src)) {
        offenders.push(`${path.relative(ROOT, file)}: bare useTranslations()`);
      }
      if (/\buseMessages\s*\(/.test(src)) {
        offenders.push(`${path.relative(ROOT, file)}: useMessages`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every configured message path exists in both catalogs", () => {
    for (const p of allConfiguredPaths) {
      expect(messageAt(EN, p), `en.json: ${p}`).toBeDefined();
      expect(messageAt(ES, p), `es.json: ${p}`).toBeDefined();
    }
  });

  it("every configured appDir exists on disk", () => {
    for (const section of Object.values(SECTION_CLIENT_MESSAGES)) {
      expect(existsSync(path.join(APP, section.appDir)), section.appDir).toBe(true);
    }
  });

  it("subsets stay a small fraction of the catalog", () => {
    // The whole point. If a section's subset creeps past a third of the full
    // catalog, someone listed a giant namespace; the mapping has failed at
    // its job and this suite should say so.
    const full = JSON.stringify(EN).length;
    for (const [name, section] of Object.entries(SECTION_CLIENT_MESSAGES)) {
      const size = JSON.stringify(
        pickMessages(EN, [...GLOBAL_CLIENT_MESSAGE_PATHS, ...section.paths])
      ).length;
      expect(size, `${name} subset is ${size}B of ${full}B`).toBeLessThan(full / 3);
    }
    const globalSize = JSON.stringify(
      pickMessages(EN, GLOBAL_CLIENT_MESSAGE_PATHS)
    ).length;
    expect(globalSize, "global subset").toBeLessThan(2_000);
  });
});

describe("pickMessages", () => {
  const tree = {
    a: { b: { c: "leaf", d: "other" }, e: "sibling" },
    f: "top"
  };

  it("picks nested paths preserving structure", () => {
    expect(pickMessages(tree, ["a.b.c"])).toEqual({ a: { b: { c: "leaf" } } });
  });

  it("merges overlapping picks without clobbering", () => {
    expect(pickMessages(tree, ["a.b.c", "a.e", "f"])).toEqual({
      a: { b: { c: "leaf" }, e: "sibling" },
      f: "top"
    });
  });

  it("a broad pick then a narrow one keeps the broad subtree", () => {
    expect(pickMessages(tree, ["a.b", "a.b.c"])).toEqual({
      a: { b: { c: "leaf", d: "other" } }
    });
  });

  it("skips unknown paths and paths through leaves", () => {
    expect(pickMessages(tree, ["nope", "a.b.c.too.deep", "f.not.an.object"])).toEqual(
      {}
    );
  });
});
