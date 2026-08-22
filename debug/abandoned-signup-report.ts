/**
 * Dry-run report for the abandoned-signup sweep.
 *
 * Runs the REAL sweep logic against the live fleet with `dryRun: true`, so it
 * deletes nothing and prints the verdict for every business: which rows would
 * be removed, and the reason each surviving row was spared. Use it to confirm
 * the guards behave before trusting the cron, and after any change to them.
 *
 * Usage: tsx debug/abandoned-signup-report.ts
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { sweepAbandonedSignups } = await import(
  "../src/lib/onboarding/abandoned-signup-cleanup.ts"
);
const { listBusinesses } = await import("../src/lib/db/businesses.ts");

const db = await createSupabaseServiceClient();
const businesses = await listBusinesses(db);
const names = new Map(businesses.map((b) => [b.id, b.name]));

const result = await sweepAbandonedSignups({ client: db, dryRun: true });

console.log(`scanned ${result.scanned} businesses\n`);

console.log(`WOULD DELETE (${result.deleted.length}):`);
for (const row of result.deleted) {
  console.log(`  ${row.id}  ${row.name}  created ${row.createdAt}`);
}
if (result.deleted.length === 0) console.log("  (none)");

console.log(`\nSPARED (${result.skipped.length}):`);
const byReason = new Map<string, string[]>();
for (const row of result.skipped) {
  const list = byReason.get(row.reason) ?? [];
  list.push(`${row.id}  ${names.get(row.id) ?? "?"}`);
  byReason.set(row.reason, list);
}
for (const [reason, rows] of [...byReason].sort()) {
  console.log(`  ${reason} (${rows.length}):`);
  for (const row of rows) console.log(`     ${row}`);
}

if (result.errors.length > 0) {
  console.log(`\nERRORS (${result.errors.length}):`);
  for (const err of result.errors) console.log(`  ${err.businessId}: ${err.message}`);
}
if (result.cappedAtLimit) {
  console.log("\nNOTE: hit the per-run delete cap, more candidates remain.");
}
