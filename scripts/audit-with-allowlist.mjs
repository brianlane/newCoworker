/**
 * npm audit with a documented, EXPIRING allowlist.
 *
 * Why this exists (2026-08-07): two high advisories were published against
 * image-size (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) with no patched
 * release. Raw `npm audit --audit-level=high` offers no exception mechanism,
 * so an unpatchable advisory blocks every PR in the repo until upstream
 * ships, which punishes unrelated work without making anything safer.
 * image-size 2.0.3 (Sep 2026) patched both; the allowlist rows were removed
 * and the package is pinned via the root override. The mechanism stays for
 * the next advisory that has no release yet.
 *
 * The allowlist is deliberately hostile to lingering:
 * - every entry carries an `expires` date; past it the advisory fails again,
 *   forcing a human to re-check upstream instead of the exception rotting;
 * - an entry whose advisory no longer appears in the audit FAILS the run
 *   (stale-entry ratchet, same philosophy as the step-field parity
 *   baseline), so fixed advisories cannot leave dead exceptions behind;
 * - only the ids listed are excused; any OTHER high+ advisory still fails.
 *
 * Registry outages: `npm audit --json` on a 503 still prints JSON, just not
 * an audit report (no `vulnerabilities` object). Treating that as "zero
 * advisories" trips the stale-entry ratchet and looks like a lockfile
 * change. Retry across most of the 10-minute CI job, then exit 2: we could
 * not ask, which is not "no advisories".
 *
 * Usage (from any package dir):
 *   node <repo>/scripts/audit-with-allowlist.mjs [--omit=dev]
 * The allowlist lives at <repo>/.github/audit-allowlist.json.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = join(repoRoot, ".github", "audit-allowlist.json");
const FAIL_LEVELS = new Set(["high", "critical"]);

/**
 * A real `npm audit --json` report always has a `vulnerabilities` object,
 * even when it is empty. A registry 503 body looks like
 * `{ statusCode: 503, message, error }` and must not be scored.
 *
 * @param {unknown} report
 * @returns {report is { vulnerabilities: Record<string, unknown> }}
 */
export function isSuccessfulAuditReport(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return false;
  }
  const vulns = /** @type {{ vulnerabilities?: unknown }} */ (report).vulnerabilities;
  return typeof vulns === "object" && vulns !== null && !Array.isArray(vulns);
}

/**
 * Collect the distinct high+ advisories (GHSA id, package, title).
 *
 * @param {{ vulnerabilities: Record<string, { severity?: string; via?: unknown }> }} report
 * @returns {Map<string, { id: string; package: string; title: string }>}
 */
export function collectHighAdvisories(report) {
  const found = new Map();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
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
  return found;
}

/**
 * Score high+ findings against the per-tree allowlist.
 *
 * @param {{
 *   found: Map<string, { id: string; package: string; title: string }>;
 *   allowlist: { advisory: string; package: string; dir?: string; reason: string; expires: string }[];
 *   relCwd: string;
 *   today: string;
 * }} args
 * @returns {{ failures: string[]; allowlisted: string[] }}
 */
export function evaluateAllowlist({ found, allowlist, relCwd, today }) {
  const allowed = new Map(
    allowlist.filter((e) => (e.dir ?? ".") === relCwd).map((e) => [e.advisory, e])
  );
  const failures = [];
  const allowlisted = [];
  for (const adv of found.values()) {
    const entry = allowed.get(adv.id);
    if (!entry) {
      failures.push(`UNLISTED high+ advisory: ${adv.id} (${adv.package}) ${adv.title}`);
    } else if (String(entry.expires) < today) {
      failures.push(
        `EXPIRED allowlist entry: ${adv.id} (${adv.package}) expired ${entry.expires}; re-check upstream for a patched release before extending`
      );
    } else {
      allowlisted.push(
        `allowlisted: ${adv.id} (${adv.package}) until ${entry.expires}: ${entry.reason}`
      );
    }
  }
  // The ratchet: an exception for an advisory the audit no longer reports is
  // dead weight that would silently excuse a future regression. Only run this
  // against a real audit report, never against a 503 / empty endpoint body.
  for (const entry of allowed.values()) {
    if (!found.has(entry.advisory)) {
      failures.push(
        `STALE allowlist entry: ${entry.advisory} no longer appears in this tree's audit; remove it from .github/audit-allowlist.json`
      );
    }
  }
  return { failures, allowlisted };
}

function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch {
    // No allowlist file means no exceptions, which is the safe default.
    return [];
  }
}

function relativeCwd() {
  // Entries are scoped to ONE package tree (`dir`, relative to the repo root,
  // "." for the root): the workflow audits seven trees, and an advisory that
  // exists only in the root must not excuse anything (or trip the stale
  // ratchet) in the six trees that never had it.
  return process.cwd().startsWith(repoRoot)
    ? process.cwd().slice(repoRoot.length).replace(/^\//, "") || "."
    : process.cwd();
}

/**
 * How long to keep asking npm while the advisory endpoint is in maintenance.
 * Override in tests with AUDIT_RETRY_ATTEMPTS / AUDIT_RETRY_DELAY_MS.
 */
export function auditRetryPlan() {
  const attempts = Number.parseInt(process.env.AUDIT_RETRY_ATTEMPTS ?? "20", 10);
  const delayMs = Number.parseInt(process.env.AUDIT_RETRY_DELAY_MS ?? "20000", 10);
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 20,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 20000
  };
}

function runNpmAudit(args) {
  try {
    return execFileSync("npm", ["audit", ...args, "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (err) {
    // npm audit exits 1 when vulnerabilities exist; the JSON is still on
    // stdout. Any other failure (no lockfile, registry down) has none.
    const stdout = err && typeof err.stdout === "string" ? err.stdout : "";
    if (!stdout.trim()) {
      return JSON.stringify({
        message: `npm audit produced no JSON output: ${err?.message ?? err}`
      });
    }
    return stdout;
  }
}

function auditEndpointFailureHint(report) {
  if (report === null || typeof report !== "object") return "unknown";
  const rec = /** @type {Record<string, unknown>} */ (report);
  if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
  const body = rec.body;
  if (body && typeof body === "object" && typeof /** @type {Record<string, unknown>} */ (body).error === "string") {
    return /** @type {string} */ (/** @type {Record<string, unknown>} */ (body).error);
  }
  if (typeof rec.statusCode === "number") return `HTTP ${rec.statusCode}`;
  return "unknown";
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  const allowlist = loadAllowlist();
  const args = process.argv.slice(2);
  const { attempts, delayMs } = auditRetryPlan();
  let report = null;
  let lastHint = "unknown";
  for (let i = 1; i <= attempts; i++) {
    const auditJson = runNpmAudit(args);
    try {
      report = JSON.parse(auditJson);
    } catch (err) {
      report = { message: `npm audit output was not JSON: ${err?.message ?? err}` };
    }
    if (isSuccessfulAuditReport(report)) break;
    lastHint = auditEndpointFailureHint(report);
    console.error(`npm audit attempt ${i}/${attempts} failed: ${lastHint}`);
    if (i === attempts) {
      console.error("npm audit did not return a vulnerability report:", lastHint);
      process.exit(2);
    }
    await sleep(delayMs);
  }
  if (!isSuccessfulAuditReport(report)) {
    console.error("npm audit did not return a vulnerability report:", lastHint);
    process.exit(2);
  }
  const found = collectHighAdvisories(report);
  const { failures, allowlisted } = evaluateAllowlist({
    found,
    allowlist,
    relCwd: relativeCwd(),
    today: new Date().toISOString().slice(0, 10)
  });
  for (const line of allowlisted) console.log(line);
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`audit clean: ${found.size} allowlisted, 0 unlisted high+ advisories`);
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (thisFile === invokedAs) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
