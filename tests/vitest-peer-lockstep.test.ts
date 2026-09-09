import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * vitest, @vitest/coverage-v8, and @vitest/ui peer an exact vitest version
 * of each other. Dependabot #1819, #1820, and #1821 each bumped one package
 * from 4.1.11 to 5.0.0 and left the other two on 4, so `npm ci` died with
 * ERESOLVE before any test ran.
 *
 * The green path is the root `vitest` group in .github/dependabot.yml, which
 * has no update-types so majors ride it too. This test is the enforcement
 * for that config and for human edits: a split bump goes red here instead
 * of in CI's install step.
 */

const ROOT = join(__dirname, "..");
const VITEST_PACKAGES = ["vitest", "@vitest/coverage-v8", "@vitest/ui"] as const;

type Pkg = {
  devDependencies?: Record<string, string>;
};

type Lock = {
  packages?: Record<string, { version?: string }>;
};

function pinned(spec: string, name: string): string {
  const match = /^\^?(\d+\.\d+\.\d+)$/.exec(spec);
  expect(
    match,
    `${name} must be pinned to a caret or exact x.y.z (got ${JSON.stringify(spec)})`
  ).not.toBeNull();
  return match![1];
}

function rootNpmBlock(yml: string): string {
  const match =
    /package-ecosystem:\s*npm\n\s*directory:\s*"\/"\n[\s\S]*?(?=\n  - package-ecosystem:|\n*$)/.exec(
      yml
    );
  expect(
    match,
    'dependabot.yml must have a root npm ecosystem at directory "/"'
  ).not.toBeNull();
  return match![0];
}

describe("vitest packages stay on one version and one Dependabot PR", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Pkg;
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as Lock;
  const yml = readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8");

  it("pins vitest, coverage-v8, and ui to the same x.y.z", () => {
    const versions = VITEST_PACKAGES.map((name) => {
      const spec = pkg.devDependencies?.[name];
      expect(spec, `package.json devDependencies must list ${name}`).toBeDefined();
      return pinned(spec!, name);
    });
    expect(
      new Set(versions).size,
      `vitest packages drifted: ${VITEST_PACKAGES.map(
        (name, i) => `${name}@${versions[i]}`
      ).join(", ")}. Bump all three together.`
    ).toBe(1);
  });

  it("keeps package-lock in step with those pins", () => {
    const spec = pkg.devDependencies?.vitest;
    const expected = pinned(spec!, "vitest");
    for (const name of VITEST_PACKAGES) {
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      expect(
        locked,
        `package-lock is missing node_modules/${name}`
      ).toBe(expected);
    }
  });

  it("groups those packages in dependabot.yml so majors cannot split", () => {
    const root = rootNpmBlock(yml);
    const groups = /groups:\n([\s\S]*?)(?:\n    ignore:|\n    [a-z]|\n  - |\n$)/.exec(root);
    expect(groups, "root npm ecosystem must declare groups").not.toBeNull();
    const body = groups![1];
    const vitestIdx = body.search(/^      vitest:/m);
    const catchAllIdx = body.search(/^      minor-and-patch:/m);
    expect(vitestIdx, "root npm groups must include a vitest: group").toBeGreaterThan(-1);
    expect(
      catchAllIdx,
      "root npm groups must still include minor-and-patch for everything else"
    ).toBeGreaterThan(-1);
    expect(
      vitestIdx,
      "the vitest group must sit above minor-and-patch so it wins the first-match assignment"
    ).toBeLessThan(catchAllIdx);
    expect(body).toContain('"vitest"');
    expect(body).toContain('"@vitest/*"');
    const vitestGroup = body.slice(vitestIdx, catchAllIdx);
    expect(
      /update-types:/.test(vitestGroup),
      "the vitest group must not set update-types: majors have to ride it"
    ).toBe(false);
    const catchAll = body.slice(catchAllIdx);
    expect(catchAll).toContain("exclude-patterns:");
    expect(catchAll).toContain('"vitest"');
    expect(catchAll).toContain('"@vitest/*"');
  });
});
