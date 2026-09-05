import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * npm forbids a literal `overrides` spec for a package you also depend on
 * directly unless the two strings match exactly. Dependabot rewrites the
 * override to the new exact version and leaves the direct range alone, so
 * the updater job on main fails with:
 *
 *   Override for postcss@8.5.26 conflicts with direct dependency.
 *
 * That is what happened on 2026-09-05 for postcss, axios, and sharp. The
 * documented npm idiom is `"foo": "$foo"`: nested copies follow the direct
 * pin, and Dependabot only has to bump the direct entry.
 *
 * Literal overrides remain correct for packages that are NOT direct deps
 * (the orphaned safety pins, and every sub-tree pin today).
 */

const ROOT = join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "dist"]);

type Pkg = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

function walkPackageJson(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkPackageJson(full, out);
    } else if (name === "package.json") {
      out.push(full);
    }
  }
}

function loadPkg(path: string): Pkg {
  return JSON.parse(readFileSync(path, "utf8")) as Pkg;
}

function directNames(pkg: Pkg): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
}

describe("package.json overrides vs direct dependencies", () => {
  const files: string[] = [];
  walkPackageJson(ROOT, files);

  it("finds the root package.json and at least the known sub-trees", () => {
    const rel = files.map((f) => f.slice(ROOT.length + 1));
    expect(rel).toContain("package.json");
    expect(rel).toContain("vps/aiflow-render/package.json");
    expect(rel).toContain("cloudflare/email-worker/package.json");
    expect(rel).toContain("zapier/package.json");
  });

  it("uses $name for every override that is also a direct dependency", () => {
    const violations: string[] = [];
    for (const file of files) {
      const pkg = loadPkg(file);
      const overrides = pkg.overrides;
      if (!overrides) continue;
      const direct = directNames(pkg);
      const rel = file.slice(ROOT.length + 1);
      for (const [name, spec] of Object.entries(overrides)) {
        if (!direct.has(name)) continue;
        if (spec === `$${name}`) continue;
        violations.push(
          `${rel}: override "${name}" is ${JSON.stringify(spec)} but ${name} is also a direct dependency. Use "$${name}" so Dependabot can bump the direct pin without EOVERRIDE.`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("documents every root override in docs/DEPENDENCY-OVERRIDES.md", () => {
    const pkg = loadPkg(join(ROOT, "package.json"));
    const docs = readFileSync(join(ROOT, "docs/DEPENDENCY-OVERRIDES.md"), "utf8");
    const missing = Object.keys(pkg.overrides ?? {}).filter((name) => !docs.includes(name));
    expect(missing, `root overrides missing from docs/DEPENDENCY-OVERRIDES.md: ${missing.join(", ")}`).toEqual([]);
  });
});
