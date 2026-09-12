/**
 * Waitlist for overrides we pinned because npm had NO patched release.
 *
 * Dependabot does not bump `overrides`, and a `>=0.6.0` floor stays on the
 * vulnerable lockfile copy until something regenerates it. A comment in a
 * PR ("raise the pin when 0.6.1 publishes") is not a reminder.
 *
 * `.github/unpatched-release-watch.json` is the waitlist. Each Monday
 * `.github/workflows/unpatched-release-watch.yml` runs this script:
 *   - waiting: registry is still below minRelease. Silence.
 *   - ready: registry has minRelease (or newer) and the lockfile is still
 *     behind. Exit 2. The workflow opens one tracking issue.
 *   - stale: lockfile already meets minRelease. Exit 1 until the row is
 *     deleted (same ratchet as the audit allowlist).
 *
 * When you add an override because no patched release exists, add a row
 * in the same PR. After you bump the override and lockfile, delete the row.
 *
 * Usage:
 *   node scripts/unpatched-release-watch.mjs
 *   node scripts/unpatched-release-watch.mjs --json
 *   node scripts/unpatched-release-watch.mjs --out report.md
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const watchPath = join(repoRoot, ".github", "unpatched-release-watch.json");

/**
 * @typedef {{
 *   package: string;
 *   dir: string;
 *   minRelease: string;
 *   advisory: string;
 *   reason: string;
 * }} WatchEntry
 */

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = String(a)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * @param {{ lockedVersion: string | null; registryVersion: string; minRelease: string }} input
 * @returns {"waiting" | "ready" | "stale"}
 */
export function classifyWatch({ lockedVersion, registryVersion, minRelease }) {
  const locked = lockedVersion && lockedVersion.trim() ? lockedVersion : "0.0.0";
  if (compareVersions(locked, minRelease) >= 0) return "stale";
  if (compareVersions(registryVersion, minRelease) >= 0) return "ready";
  return "waiting";
}

/**
 * @param {string} dir
 * @param {string} packageName
 * @param {string} [root]
 * @returns {string | null}
 */
export function lockedVersionFor(dir, packageName, root = repoRoot) {
  const rel = !dir || dir === "." ? "package-lock.json" : join(dir, "package-lock.json");
  const lock = JSON.parse(readFileSync(join(root, rel), "utf8"));
  const key = `node_modules/${packageName}`;
  const version = lock.packages?.[key]?.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * @param {WatchEntry} entry
 * @param {{ lockedVersion: string | null; registryVersion: string }} versions
 */
export function describeWatch(entry, versions) {
  const status = classifyWatch({
    lockedVersion: versions.lockedVersion,
    registryVersion: versions.registryVersion,
    minRelease: entry.minRelease
  });
  return {
    ...entry,
    status,
    lockedVersion: versions.lockedVersion,
    registryVersion: versions.registryVersion
  };
}

/**
 * @param {ReturnType<typeof describeWatch>[]} rows
 * @returns {string}
 */
export function formatWatchReport(rows) {
  if (rows.length === 0) {
    return "unpatched-release-watch: empty waitlist, nothing to check.";
  }
  const lines = ["unpatched-release-watch:", ""];
  for (const row of rows) {
    lines.push(
      `- ${row.status} ${row.package} in ${row.dir} (${row.advisory}): lockfile=${row.lockedVersion ?? "missing"} registry=${row.registryVersion} minRelease=${row.minRelease}`
    );
    if (row.reason) lines.push(`  ${row.reason}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} packageName
 * @returns {string}
 */
export function readRegistryVersion(packageName) {
  const out = execFileSync("npm", ["view", packageName, "version"], {
    encoding: "utf8"
  });
  return out.trim();
}

/**
 * @param {WatchEntry[]} entries
 * @param {(packageName: string) => string} [readRegistry]
 * @param {string} [root]
 */
export function evaluateWatch(entries, readRegistry = readRegistryVersion, root = repoRoot) {
  return entries.map((entry) =>
    describeWatch(entry, {
      lockedVersion: lockedVersionFor(entry.dir, entry.package, root),
      registryVersion: readRegistry(entry.package)
    })
  );
}

/**
 * @param {ReturnType<typeof describeWatch>[]} rows
 * @returns {0 | 1 | 2}
 */
export function exitCodeFor(rows) {
  if (rows.some((row) => row.status === "stale")) return 1;
  if (rows.some((row) => row.status === "ready")) return 2;
  return 0;
}

function main() {
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(watchPath, "utf8"));
  } catch (err) {
    console.error("unpatched-release-watch.json unreadable:", err?.message ?? err);
    process.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error("unpatched-release-watch.json must be an array");
    process.exit(1);
  }
  const rows = evaluateWatch(entries);
  const report = formatWatchReport(rows);
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    writeFileSync(args[outIdx + 1], `${report}\n`);
  }
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }
  process.exit(exitCodeFor(rows));
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (thisFile === invokedAs) main();
