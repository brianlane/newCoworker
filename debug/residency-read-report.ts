/**
 * Residency read-coverage report.
 *
 * Prints what the coverage guard sees, so a reviewer can check the registry
 * in tests/residency-read-coverage.test.ts against the tree in one command
 * instead of trusting a hand-maintained list. Same scanner the guard runs,
 * so the two can never disagree.
 *
 * Usage:
 *   npx tsx debug/residency-read-report.ts            # summary + the debt
 *   npx tsx debug/residency-read-report.ts --all      # every read site
 *
 * Read-only: parses source files, touches no database and no box.
 */
import { join } from "node:path";

import {
  isResidencyPurgedTable,
  RESIDENCY_CENTRAL_KEPT_TABLES,
  RESIDENCY_CENTRAL_PURGED_TABLES
} from "../src/lib/residency/tables.ts";
import { scanResidencyReads, siteKey } from "../tests/helpers/residency-read-scan.ts";

const showAll = process.argv.includes("--all");
const scan = scanResidencyReads(join(import.meta.dirname, ".."));

const purgedUnrouted = scan.sites.filter((s) => !s.routed && isResidencyPurgedTable(s.table));
const keptUnrouted = scan.sites.filter((s) => !s.routed && !isResidencyPurgedTable(s.table));
const keptRouted = scan.sites.filter((s) => s.routed && !isResidencyPurgedTable(s.table));

console.log("residency read coverage\n");
console.log(`  files parsed         ${scan.filesParsed}`);
console.log(`  read sites           ${scan.sites.length}  (routed ${scan.sites.filter((s) => s.routed).length})`);
console.log(`  write sites          ${scan.writeSites}  (trigger-covered, not gated)`);
console.log(`  dynamic .from(expr)  ${scan.dynamic.length}\n`);
console.log(`  purged tables        ${RESIDENCY_CENTRAL_PURGED_TABLES.length}  central loses these at purge`);
console.log(`  kept-central tables  ${RESIDENCY_CENTRAL_KEPT_TABLES.length}  central stays complete\n`);
console.log(`  CENTRAL READS OF A PURGED TABLE   ${purgedUnrouted.length}  <- the debt`);
console.log(`  central reads of a kept table     ${keptUnrouted.length}  correct today`);
console.log(`  box-ward reads of a kept table    ${keptRouted.length}  deliberate, recorded\n`);

const show = showAll ? scan.sites : purgedUnrouted;
console.log(showAll ? "all read sites:" : "central reads of a purged table:");
for (const s of show) {
  const flag = s.routed ? "routed " : isResidencyPurgedTable(s.table) ? "DEBT   " : "central";
  console.log(`  ${flag}  ${siteKey(s)}  (${s.file}:${s.line})`);
}

if (scan.dynamic.length > 0) {
  console.log("\ndynamic .from(expr) sites (table unknown to any scanner):");
  for (const d of scan.dynamic) {
    console.log(`  ${d.file}::${d.fn}  (${d.file}:${d.line})  ${d.verb} arg=${d.argText}`);
  }
}
