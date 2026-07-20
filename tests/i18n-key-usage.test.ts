/**
 * Guards against translation keys that are referenced in code but missing
 * from the message catalogs. The key-parity test (i18n-messages.test.ts)
 * only compares en.json against es.json, so a key filed under the wrong
 * namespace in BOTH catalogs passes it silently — that is exactly how the
 * marketing footer shipped a literal "marketing.nav.vsGohighlevel" label
 * (fixed in #777). This test statically scans src/ for translator bindings
 * (useTranslations / getTranslations) and verifies that:
 *
 *   1. every static string key passed to a translator exists in en.json
 *      under one of that variable's bound namespaces, and
 *   2. for the common indirect idiom — a `labelKey: "..."` table resolved
 *      through a translator (`t(item.labelKey)`) — every labelKey literal in
 *      that file exists under the calling translator's namespace.
 *
 * Dynamic keys (template literals like t(`${key}.title`)) cannot be checked
 * statically and are skipped. Cross-file labelKey catalogs are asserted
 * explicitly at the bottom.
 *
 * en.json is the source of truth here; the parity test guarantees es.json
 * has an identical key tree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { SIDEBAR_ITEMS } from "../src/lib/dashboard/sidebar-items";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

function catalogHas(dottedKey: string): boolean {
  let node: unknown = en;
  for (const part of dottedKey.split(".")) {
    if (!node || typeof node !== "object" || !(part in (node as Record<string, unknown>))) {
      return false;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield path;
    }
  }
}

/**
 * Maps each translator variable in a file to the set of namespaces it is
 * bound to. The same name can be bound in multiple components of one file
 * (e.g. `const t = useTranslations(...)` in two components), so a key is
 * accepted if it resolves under ANY of the variable's namespaces — this
 * avoids false positives at the cost of a narrow false-negative window.
 */
function translatorBindings(source: string): Map<string, Set<string>> {
  const bindings = new Map<string, Set<string>>();
  const re =
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["'`]([\w.-]+)["'`]\s*\)/g;
  for (const match of source.matchAll(re)) {
    const [, varName, namespace] = match;
    if (!bindings.has(varName)) bindings.set(varName, new Set());
    bindings.get(varName)!.add(namespace);
  }
  return bindings;
}

type Finding = { file: string; key: string; namespaces: string[] };

function scanFile(path: string): Finding[] {
  const source = readFileSync(path, "utf8");
  const bindings = translatorBindings(source);
  if (bindings.size === 0) return [];

  const file = relative(ROOT, path);
  const findings: Finding[] = [];

  for (const [varName, namespaces] of bindings) {
    const nsList = [...namespaces];

    // 1. Static keys: t("key"), t.rich("key", ...), t.raw("key"), t.markup("key")
    const staticCallRe = new RegExp(
      `\\b${varName}(?:\\.(?:rich|raw|markup))?\\(\\s*["']([\\w.-]+)["']`,
      "g"
    );
    for (const match of source.matchAll(staticCallRe)) {
      const key = match[1];
      if (!nsList.some((ns) => catalogHas(`${ns}.${key}`))) {
        findings.push({ file, key, namespaces: nsList });
      }
    }

    // 2. Indirect labelKey tables: if this translator is ever called with a
    // `labelKey` expression (t(item.labelKey), t(labelKey)), every
    // labelKey literal declared in this file must resolve under its
    // namespace(s).
    const labelKeyCallRe = new RegExp(`\\b${varName}\\(\\s*[\\w.]*\\blabelKey\\b\\s*\\)`);
    if (labelKeyCallRe.test(source)) {
      for (const match of source.matchAll(/\blabelKey:\s*["']([\w.-]+)["']/g)) {
        const key = match[1];
        if (!nsList.some((ns) => catalogHas(`${ns}.${key}`))) {
          findings.push({ file, key, namespaces: nsList });
        }
      }
    }
  }

  return findings;
}

describe("translation keys referenced in src/ exist in the catalogs", () => {
  it("every statically-referenced key resolves in en.json", () => {
    const findings: Finding[] = [];
    for (const path of walkSourceFiles(SRC)) {
      findings.push(...scanFile(path));
    }
    const report = findings
      .map((f) => `  ${f.file}: "${f.key}" not found under namespace(s) ${f.namespaces.join(", ")}`)
      .join("\n");
    expect(findings, `missing translation keys:\n${report}`).toEqual([]);
  });

  // Cross-file labelKey catalogs the file-local heuristic above cannot see:
  // the table lives in one module and the translator call in another.

  it("dashboard sidebar item labels exist under dashboard.nav", () => {
    for (const item of SIDEBAR_ITEMS) {
      expect(catalogHas(`dashboard.nav.${item.labelKey}`), `dashboard.nav.${item.labelKey}`).toBe(
        true
      );
    }
  });

  it("activity badge labels exist under dashboard.activityBadge", () => {
    // Source-scan instead of importing: activity-badge.ts sits under
    // src/components and importing it here is unnecessary for the check.
    const source = readFileSync(
      join(SRC, "components/dashboard/activity-badge.ts"),
      "utf8"
    );
    const labelKeys = [...source.matchAll(/\blabelKey:\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(labelKeys.length).toBeGreaterThan(0);
    for (const key of labelKeys) {
      expect(catalogHas(`dashboard.activityBadge.${key}`), `dashboard.activityBadge.${key}`).toBe(
        true
      );
    }
  });

  it("industry i18nKeys exist under marketing.industries", () => {
    const source = readFileSync(join(SRC, "app/industries/data.tsx"), "utf8");
    const i18nKeys = [...source.matchAll(/\bi18nKey:\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(i18nKeys.length).toBeGreaterThan(0);
    for (const key of i18nKeys) {
      // The industry pages read `<i18nKey>.name` / `.teaser` and more; name
      // is the sentinel every industry entry must have.
      expect(catalogHas(`marketing.industries.${key}.name`), `marketing.industries.${key}.name`).toBe(
        true
      );
    }
  });
});
