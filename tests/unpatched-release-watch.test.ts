import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWatch,
  compareVersions,
  describeWatch,
  exitCodeFor,
  formatWatchReport,
  lockedVersionFor
} from "../scripts/unpatched-release-watch.mjs";

describe("compareVersions", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("0.6.1", "0.6.0")).toBe(1);
    expect(compareVersions("0.6.0", "0.6.1")).toBe(-1);
    expect(compareVersions("0.6.1", "0.6.1")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });
});

describe("classifyWatch", () => {
  it("is waiting while the registry is still below the floor", () => {
    expect(
      classifyWatch({
        lockedVersion: "0.6.0",
        registryVersion: "0.6.0",
        minRelease: "0.6.1"
      })
    ).toBe("waiting");
  });

  it("is ready when npm has the floor and the lockfile does not", () => {
    expect(
      classifyWatch({
        lockedVersion: "0.6.0",
        registryVersion: "0.6.1",
        minRelease: "0.6.1"
      })
    ).toBe("ready");
  });

  it("is stale when the lockfile already meets the floor", () => {
    expect(
      classifyWatch({
        lockedVersion: "0.6.1",
        registryVersion: "0.6.1",
        minRelease: "0.6.1"
      })
    ).toBe("stale");
  });

  it("treats a missing lockfile copy as 0.0.0", () => {
    expect(
      classifyWatch({
        lockedVersion: null,
        registryVersion: "0.6.1",
        minRelease: "0.6.1"
      })
    ).toBe("ready");
  });
});

describe("exitCodeFor / formatWatchReport", () => {
  const entry = {
    package: "adm-zip",
    dir: "zapier",
    minRelease: "0.6.1",
    advisory: "GHSA-vwc7-r8mq-g2x9",
    reason: "symlink extract"
  };

  it("exits 0 for an empty waitlist or every row still waiting", () => {
    expect(exitCodeFor([])).toBe(0);
    expect(
      exitCodeFor([
        describeWatch(entry, { lockedVersion: "0.6.0", registryVersion: "0.6.0" })
      ])
    ).toBe(0);
  });

  it("exits 2 when a waited-on release is on npm", () => {
    expect(
      exitCodeFor([
        describeWatch(entry, { lockedVersion: "0.6.0", registryVersion: "0.6.1" })
      ])
    ).toBe(2);
  });

  it("exits 1 for a leftover row after the lockfile was already bumped", () => {
    expect(
      exitCodeFor([
        describeWatch(entry, { lockedVersion: "0.6.1", registryVersion: "0.6.1" })
      ])
    ).toBe(1);
  });

  it("prefers the stale failure when a batch mixes ready and stale", () => {
    expect(
      exitCodeFor([
        describeWatch(entry, { lockedVersion: "0.6.0", registryVersion: "0.6.1" }),
        describeWatch(
          { ...entry, package: "other" },
          { lockedVersion: "1.0.0", registryVersion: "1.0.0" }
        )
      ])
    ).toBe(1);
  });

  it("names status, tree, and advisory in the report", () => {
    const report = formatWatchReport([
      describeWatch(entry, { lockedVersion: "0.6.0", registryVersion: "0.6.1" })
    ]);
    expect(report).toContain("ready adm-zip in zapier (GHSA-vwc7-r8mq-g2x9)");
    expect(report).toContain("minRelease=0.6.1");
  });

  it("has a quiet empty-waitlist line", () => {
    expect(formatWatchReport([])).toContain("empty waitlist");
  });
});

describe("lockedVersionFor", () => {
  it("reads node_modules/<package> out of a lockfile tree", () => {
    const root = mkdtempSync(join(tmpdir(), "unpatched-watch-"));
    mkdirSync(join(root, "zapier"));
    writeFileSync(
      join(root, "zapier", "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/adm-zip": { version: "0.6.1" } }
      })
    );
    expect(lockedVersionFor("zapier", "adm-zip", root)).toBe("0.6.1");
  });
});

describe("wiring", () => {
  const root = join(__dirname, "..");

  it("keeps the waitlist file as a JSON array", () => {
    const watch = JSON.parse(
      readFileSync(join(root, ".github/unpatched-release-watch.json"), "utf8")
    );
    expect(Array.isArray(watch)).toBe(true);
  });

  it("exits 0 on the live empty waitlist without touching npm view", () => {
    const out = execFileSync("node", ["scripts/unpatched-release-watch.mjs"], {
      encoding: "utf8",
      cwd: root
    });
    expect(out).toContain("empty waitlist");
  });

  it("wires the Monday workflow to the script and waitlist", () => {
    const yml = readFileSync(
      join(root, ".github/workflows/unpatched-release-watch.yml"),
      "utf8"
    );
    expect(yml).toContain("node scripts/unpatched-release-watch.mjs");
    expect(yml).toContain("unpatched-release-watch.json");
    expect(yml).toContain("cron: \"48 4 * * 1\"");
    expect(yml).toContain("issues: write");
  });

  it("lists zapier in dependabot.yml so the lockfile refreshes weekly", () => {
    const yml = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
    expect(yml).toMatch(/package-ecosystem:\s*npm\n\s*directory:\s*"\/zapier"/);
  });

  it("resolves zapier adm-zip to the GHSA-vwc7-r8mq-g2x9 patched floor", () => {
    const lock = JSON.parse(
      readFileSync(join(root, "zapier/package-lock.json"), "utf8")
    ) as { packages?: Record<string, { version?: string }> };
    const zip = lock.packages?.["node_modules/adm-zip"];
    expect(zip, "adm-zip must be in zapier/package-lock.json").toBeTruthy();
    expect(compareVersions(zip!.version ?? "0.0.0", "0.6.1") >= 0).toBe(true);
  });
});
