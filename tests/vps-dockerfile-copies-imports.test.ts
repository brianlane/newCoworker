import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every no-build-step sidecar's Dockerfile lists its source files by name
 * (`COPY server.mjs actions.mjs login.mjs ./`). A module that server.mjs
 * imports but the Dockerfile does not copy is INVISIBLE until a redeploy: the
 * file rsyncs to the box perfectly well, the image simply does not contain it,
 * and the container then dies at startup with ERR_MODULE_NOT_FOUND and never
 * binds 8080. The tenant's browse steps go down with it.
 *
 * That happened on 2026-08-17: `login.mjs` was split out of `server.mjs` and
 * this line was not updated, so the redeploy that shipped the login fix took
 * Amy Laidlaw's sidecar offline instead.
 *
 * Widened to the data-api when `filters.mjs` was split out of ITS server.mjs
 * for the same reason (a compiler that could not be tested where it lived).
 * Identical shape, identical failure mode, so it gets the same guard rather
 * than a copy of it that can drift.
 *
 * The Dockerfile's own header already warns about the same SHAPE of bug for the
 * Playwright base-image tag ("LATENT: nothing breaks until the next rebuild").
 * This test makes the file-copy half of it fail in CI instead.
 */

/** Sidecars that ship as plain .mjs with no build step. */
const SIDECARS = ["aiflow-render", "data-api"] as const;

/** Local `./x.mjs` specifiers imported by a module. */
function localImports(source: string): string[] {
  return [...source.matchAll(/from\s+"\.\/([A-Za-z0-9._-]+\.mjs)"/g)].map((m) => m[1]);
}

describe.each(SIDECARS)("vps/%s Dockerfile", (sidecar) => {
  const DIR = join(process.cwd(), "vps", sidecar);
  const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
  const dockerfile = read("Dockerfile");
  const copied = new Set(
    dockerfile
      .split("\n")
      .filter((l) => l.startsWith("COPY "))
      .flatMap((l) => l.replace(/^COPY\s+/, "").split(/\s+/))
      .filter((t) => t.endsWith(".mjs"))
  );

  it("copies every local .mjs that server.mjs imports", () => {
    const missing = localImports(read("server.mjs")).filter((f) => !copied.has(f));
    expect(missing, `Dockerfile COPY is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("copies every local .mjs those modules import in turn", () => {
    // One level deeper, because a helper module pulled in by actions.mjs or
    // login.mjs would fail exactly the same way.
    const missing: string[] = [];
    for (const entry of [...copied]) {
      let source: string;
      try {
        source = read(entry);
      } catch {
        continue; // covered by the "copies files that exist" case below
      }
      for (const dep of localImports(source)) if (!copied.has(dep)) missing.push(`${entry} -> ${dep}`);
    }
    expect(missing, `transitively imported but not copied: ${missing.join(", ")}`).toEqual([]);
  });

  it("only copies files that actually exist", () => {
    // The inverse mistake: a rename leaves a stale name here, and `COPY` fails
    // the BUILD rather than the run, which is louder but still only on deploy.
    const absent = [...copied].filter((f) => {
      try {
        read(f);
        return false;
      } catch {
        return true;
      }
    });
    expect(absent, `Dockerfile copies files that do not exist: ${absent.join(", ")}`).toEqual([]);
  });

  it("starts the module named in CMD", () => {
    const cmd = /CMD\s+\["node",\s*"([^"]+)"\]/.exec(dockerfile)?.[1];
    expect(cmd).toBeTruthy();
    expect(copied.has(cmd!)).toBe(true);
  });
});
