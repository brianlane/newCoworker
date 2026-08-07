/**
 * npm audit with a documented, EXPIRING allowlist.
 *
 * Why this exists (2026-08-07): two high advisories were published against
 * image-size (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) with NO patched
 * release: every version is affected. Raw `npm audit --audit-level=high`
 * offers no exception mechanism, so an unpatchable advisory blocks every PR
 * in the repo until upstream ships, which punishes unrelated work without
 * making anything safer.
 *
 * The allowlist is deliberately hostile to lingering:
 * - every entry carries an `expires` date; past it the advisory fails again,
 *   forcing a human to re-check upstream instead of the exception rotting;
 * - an entry whose advisory no longer appears in the audit FAILS the run
 *   (stale-entry ratchet, same philosophy as the step-field parity
 *   baseline), so fixed advisories cannot leave dead exceptions behind;
 * - only the ids listed are excused; any OTHER high+ advisory still fails.
 *
 * Usage (from any package dir):
 *   node <repo>/scripts/audit-with-allowlist.mjs [--omit=dev]
 * The allowlist lives at <repo>/.github/audit-allowlist.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = join(repoRoot, ".github", "audit-allowlist.json");

/** @type {{ advisory: string; package: string; dir: string; reason: string; expires: string }[]} */
let allowlist = [];
try {
  allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
} catch {
  // No allowlist file means no exceptions, which is the safe default.
  allowlist = [];
}

const FAIL_LEVELS = new Set(["high", "critical"]);
const args = process.argv.slice(2);

// Entries are scoped to ONE package tree (`dir`, relative to the repo root,
// "." for the root): the workflow audits seven trees, and an advisory that
// exists only in the root must not excuse anything (or trip the stale
// ratchet) in the six trees that never had it.
const relCwd = process.cwd().startsWith(repoRoot)
  ? process.cwd().slice(repoRoot.length).replace(/^\//, "") || "."
  : process.cwd();

let auditJson = "";
try {
  auditJson = execFileSync("npm", ["audit", ...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
} catch (err) {
  // npm audit exits 1 when vulnerabilities exist; the JSON is still on
  // stdout. Any other failure (no lockfile, registry down) has none, and
  // must fail loudly rather than read as "no advisories".
  auditJson = err && typeof err.stdout === "string" ? err.stdout : "";
  if (!auditJson.trim()) {
    console.error("npm audit produced no JSON output:", err?.message ?? err);
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(auditJson);
} catch (err) {
  console.error("npm audit output was not JSON:", err?.message ?? err);
  process.exit(2);
}

/** Collect the distinct high+ advisories (GHSA id, package, title). */
const found = new Map();
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (!FAIL_LEVELS.has(vuln.severity)) continue;
  for (const via of Array.isArray(vuln.via) ? vuln.via : []) {
    // `via` mixes advisory objects and plain package-name strings (the
    // transitive chain); only the objects carry the advisory itself.
    if (typeof via !== "object" || via === null) continue;
    if (!FAIL_LEVELS.has(via.severity)) continue;
    // Prefer the GHSA id, but an advisory published under a numeric npm URL
    // (or none at all) must still FAIL rather than slip past the gate: fall
    // back to the whole URL, then to source/package. Only entries whose
    // derived id is allowlisted are excused, whatever shape the id takes.
    const tail = String(via.url ?? "").split("/").pop() ?? "";
    const id =
      tail.startsWith("GHSA-")
        ? tail
        : String(via.url ?? "").trim() ||
          (via.source !== undefined ? `advisory-${via.source}` : `package-${via.name ?? pkg}`);
    if (!found.has(id)) {
      found.set(id, { id, package: via.name ?? pkg, title: via.title ?? "" });
    }
  }
}

const today = new Date().toISOString().slice(0, 10);
const allowed = new Map(
  allowlist.filter((e) => (e.dir ?? ".") === relCwd).map((e) => [e.advisory, e])
);

const failures = [];
for (const adv of found.values()) {
  const entry = allowed.get(adv.id);
  if (!entry) {
    failures.push(`UNLISTED high+ advisory: ${adv.id} (${adv.package}) ${adv.title}`);
  } else if (String(entry.expires) < today) {
    failures.push(
      `EXPIRED allowlist entry: ${adv.id} (${adv.package}) expired ${entry.expires}; re-check upstream for a patched release before extending`
    );
  } else {
    console.log(
      `allowlisted: ${adv.id} (${adv.package}) until ${entry.expires}: ${entry.reason}`
    );
  }
}
// The ratchet: an exception for an advisory the audit no longer reports is
// dead weight that would silently excuse a future regression.
for (const entry of allowed.values()) {
  if (!found.has(entry.advisory)) {
    failures.push(
      `STALE allowlist entry: ${entry.advisory} no longer appears in this tree's audit; remove it from .github/audit-allowlist.json`
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`audit clean: ${found.size} allowlisted, 0 unlisted high+ advisories`);
