/**
 * Residency backfill kickoff + drain (Phase B2 operator tool).
 *
 * For one enterprise business with data_residency_mode past 'supabase':
 *   1. `residency_backfill_business(uuid)` — snapshots every existing
 *      content row into residency_write_journal as 'upsert' rows, in
 *      FK-dependency order (server-side insert-select, no data transfer).
 *   2. Optionally (`--drain`) runs the replayer loop locally until the
 *      journal is empty or a drain stops on an error — useful right after
 *      a pilot bring-up instead of waiting on the per-minute cron.
 *   3. Prints per-table journal counts and a reconciliation summary
 *      (journal empty = box caught up).
 *
 * Usage:
 *   npx tsx debug/residency-backfill.ts --business <uuid> [--drain] [--base-url http://127.0.0.1:8091]
 *
 * `--base-url` bypasses the tunnel (e.g. an SSH port-forward) for smoke
 * runs; production drains resolve the data-<biz> hostname.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}

const businessId = argValue("--business");
const drain = args.includes("--drain");
const baseUrl = argValue("--base-url");

if (!businessId) {
  console.error(
    "usage: npx tsx debug/residency-backfill.ts --business <uuid> [--drain] [--base-url <url>]"
  );
  process.exit(2);
}

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const db = await createSupabaseServiceClient();

// Guard: tier + mode (the same gate everything else enforces).
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("tier, data_residency_mode, name")
  .eq("id", businessId)
  .maybeSingle();
if (bizErr || !biz) {
  console.error(`business ${businessId} not found: ${bizErr?.message ?? "no row"}`);
  process.exit(1);
}
if (biz.tier !== "enterprise" || (biz.data_residency_mode ?? "supabase") === "supabase") {
  console.error(
    `refusing: tier=${biz.tier} mode=${biz.data_residency_mode ?? "supabase"} — backfill is for residency-enabled enterprise tenants`
  );
  process.exit(1);
}

console.log(`[backfill] journaling existing content for "${biz.name}" (${businessId})...`);
const { data: counts, error: bfErr } = await db.rpc("residency_backfill_business", {
  p_business: businessId
});
if (bfErr) {
  console.error(`backfill rpc failed: ${bfErr.message}`);
  process.exit(1);
}
let total = 0;
for (const row of (counts ?? []) as Array<{ table_name: string; journaled: number }>) {
  total += Number(row.journaled);
  console.log(`  ${row.table_name.padEnd(30)} ${row.journaled}`);
}
console.log(`[backfill] ${total} rows journaled.`);

if (drain) {
  const { runResidencyReplay } = await import("../src/lib/residency/replay.ts");
  const { DataApiClient } = await import("../src/lib/residency/client.ts");
  console.log(`[drain] replaying${baseUrl ? ` via ${baseUrl}` : " via tunnel"}...`);
  const started = Date.now();
  for (;;) {
    // onlyBusinessIds pins the drain to OUR tenant: without it a large
    // shared backlog could fill the businessLimit window with other
    // tenants and this loop would misread "not scheduled" as "done".
    const summary = await runResidencyReplay({
      makeDataApi: (id) =>
        new DataApiClient(id, baseUrl && id === businessId ? { baseUrl } : {}),
      perBusinessLimit: 500,
      onlyBusinessIds: [businessId]
    });
    const mine = summary.businesses.find((b) => b.businessId === businessId);
    console.log(
      `[drain] replayed=${mine?.replayed ?? 0} skipped=${mine?.skipped ?? 0} error=${mine?.error ?? "none"}`
    );
    if (!mine || mine.error) {
      if (mine?.error) process.exit(1);
      break;
    }
    if (mine.replayed === 0 && mine.skipped === 0) break;
  }
  console.log(`[drain] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const { count } = await db
  .from("residency_write_journal")
  .select("seq", { count: "exact", head: true })
  .eq("business_id", businessId)
  .is("replayed_at", null);
console.log(`[reconcile] pending journal rows for ${businessId}: ${count ?? "?"}`);
