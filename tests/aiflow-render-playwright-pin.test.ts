import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The render sidecar's Docker base image ships the browser binaries; the
 * `playwright` npm package in the image is the library that looks for them.
 * If the two versions disagree, Chromium fails to launch with
 * "Executable doesn't exist at /ms-playwright/...".
 *
 * The failure is LATENT, which is what makes it worth a guard: nothing breaks
 * at merge time, because the running container still has the old, self
 * consistent image. It only detonates on the next rebuild, which can be weeks
 * later and will look like the redeploy caused it.
 *
 * It has bitten twice. PR #226 aligned the base image to 1.61.0 after the
 * first. Then Dependabot #1005 bumped `playwright` 1.61.0 -> 1.62.0 in this
 * package without touching the Dockerfile, and the mismatch sat unnoticed
 * until a routine render redeploy on 2026-07-31 took the sidecar down mid
 * session (Amy Laidlaw, the fleet's only tenant with live browse steps).
 *
 * Dependabot cannot bump a `FROM` line and a package.json together, so nothing
 * else closes this. Assert it here instead.
 */

const RENDER_DIR = join(__dirname, "..", "vps", "aiflow-render");

function read(name: string): string {
  return readFileSync(join(RENDER_DIR, name), "utf8");
}

describe("aiflow-render: Playwright base image matches the pinned library", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = pkg.dependencies?.playwright;

  it("pins playwright to an exact version (a range would make the base image unmatchable)", () => {
    expect(pinned).toBeDefined();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses that exact version as the Docker base image tag", () => {
    const from = /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-\S+$/m.exec(
      read("Dockerfile")
    );
    expect(
      from,
      "Dockerfile must FROM mcr.microsoft.com/playwright:v<x.y.z>-<distro>"
    ).not.toBeNull();
    expect(
      from![1],
      `Dockerfile base image is v${from![1]} but package.json pins playwright ${pinned}. ` +
        "Bump BOTH in the same PR: the mismatch does not fail CI or the running " +
        "container, it fails the next rebuild with \"Executable doesn't exist\"."
    ).toBe(pinned);
  });

  it("keeps package-lock in step with package.json", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages?: Record<string, { version?: string }>;
    };
    const locked = lock.packages?.["node_modules/playwright"]?.version;
    expect(locked).toBe(pinned);
  });
});
