#!/usr/bin/env node
/**
 * Ratchet on production-unused exports: fail CI on any NEW one.
 *
 * `knip --production` resolves the import graph from production entries
 * only, so an export whose only caller is a test shows up here. That class
 * is exactly how dead money-code stayed "alive" through the 100% coverage
 * pin twice in 2026 (assertMessengerAllowed, translatorAllowedForBusiness):
 * a test written to cover a dead export makes the export look used, and the
 * default `knip --dependencies` CI step never looks at exports at all.
 *
 * The 2026-08-27 inventory stood at ~1,700 findings, far too many to gate
 * raw, so this is a ratchet against a checked-in baseline
 * (.github/knip-exports-baseline.txt, sorted "file :: symbol" lines, no
 * line numbers so unrelated edits cannot churn it):
 *
 *   - a finding NOT in the baseline fails the run and names the symbol;
 *     either the new export gains a production caller, gets deleted, or is
 *     deliberately added to the baseline in the same PR with a reviewable
 *     diff line;
 *   - a baseline entry knip no longer reports is printed as prunable, and
 *     once more than STALE_PRUNE_THRESHOLD of them pile up the run fails
 *     until the baseline is regenerated, so the ratchet cannot rot into an
 *     allowlist of things long since fixed (same self-destruct posture as
 *     .github/audit-allowlist.json).
 *
 * Regenerate the baseline (after deleting dead exports, never instead of):
 *   node scripts/knip-exports-ratchet.mjs --write-baseline
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASELINE_PATH = ".github/knip-exports-baseline.txt";
const STALE_PRUNE_THRESHOLD = 200;

function currentFindings() {
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["knip", "--production", "--include", "exports,types", "--reporter", "json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    // knip exits non-zero when it finds issues; the JSON is still on stdout.
    raw = err.stdout;
    if (!raw) throw err;
  }
  const { issues } = JSON.parse(raw);
  const findings = new Set();
  for (const issue of issues) {
    for (const kind of ["exports", "types"]) {
      for (const entry of issue[kind] ?? []) {
        findings.add(`${issue.file} :: ${entry.name}`);
      }
    }
  }
  return findings;
}

const findings = currentFindings();

if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_PATH, [...findings].sort().join("\n") + "\n");
  console.log(`Wrote ${findings.size} entries to ${BASELINE_PATH}`);
  process.exit(0);
}

const baseline = new Set(
  readFileSync(BASELINE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
);

const fresh = [...findings].filter((f) => !baseline.has(f)).sort();
const prunable = [...baseline].filter((b) => !findings.has(b)).sort();

if (prunable.length > 0) {
  console.log(`${prunable.length} baseline entries are no longer reported (prunable):`);
  for (const p of prunable.slice(0, 20)) console.log(`  - ${p}`);
  if (prunable.length > 20) console.log(`  ... and ${prunable.length - 20} more`);
  console.log(`Regenerate with: node scripts/knip-exports-ratchet.mjs --write-baseline`);
}

if (prunable.length > STALE_PRUNE_THRESHOLD) {
  console.error(
    `FAIL: ${prunable.length} stale baseline entries exceed the ${STALE_PRUNE_THRESHOLD} cap. ` +
      `Regenerate the baseline so the ratchet stays honest.`
  );
  process.exit(1);
}

if (fresh.length > 0) {
  console.error(`FAIL: ${fresh.length} NEW production-unused export(s):`);
  for (const f of fresh) console.error(`  - ${f}`);
  console.error(
    "Give it a production caller, delete it, or add it to " +
      `${BASELINE_PATH} deliberately in this PR. An export only tests call ` +
      "is dead code wearing coverage."
  );
  process.exit(1);
}

console.log(`OK: no new production-unused exports (baseline ${baseline.size}).`);
