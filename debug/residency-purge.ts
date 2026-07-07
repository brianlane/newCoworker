/**
 * Residency central purge (Phase B4 operator tool).
 *
 * Runs residency_purge_business(uuid, keep_hours) for one vps-mode
 * enterprise tenant: deletes replicated content HISTORY from central
 * Supabase (journal-trigger-muted inside the RPC) so it rests only on the
 * tenant's box. The RPC fails closed on tier/mode mismatch or a non-empty
 * journal; this wrapper additionally runs the parity gate first unless
 * --skip-parity.
 *
 * Usage:
 *   npx tsx debug/residency-purge.ts --business <uuid> [--keep-hours 72] [--apply] [--skip-parity]
 *
 * Dry-run by default: prints what WOULD purge (counts older than the
 * cutoff) without deleting.
 */
import { spawnSync } from "node:child_process";
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}
const businessId = argValue("--business");
const keepHours = Number(argValue("--keep-hours") ?? "72");
const apply = args.includes("--apply");
const skipParity = args.includes("--skip-parity");

if (!businessId || !Number.isInteger(keepHours) || keepHours < 0) {
  console.error(
    "usage: npx tsx debug/residency-purge.ts --business <uuid> [--keep-hours 72] [--apply] [--skip-parity]"
  );
  process.exit(2);
}

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const db = await createSupabaseServiceClient();

if (!skipParity) {
  console.log("[purge] running parity gate first (disable with --skip-parity)...");
  const gate = spawnSync(
    "npx",
    ["tsx", "debug/residency-parity.ts", "--business", businessId],
    { stdio: "inherit" }
  );
  if (gate.status !== 0) {
    console.error("[purge] ABORT: parity gate failed — purging now would risk data loss");
    process.exit(1);
  }
}

if (!apply) {
  // Dry run: report what the cutoff would catch, table by table.
  const cutoffIso = new Date(Date.now() - keepHours * 3600_000).toISOString();
  console.log(`[purge] DRY RUN (cutoff ${cutoffIso}); re-run with --apply to delete\n`);
  const checks: Array<{ table: string; column: string; extra?: (q: unknown) => unknown }> = [
    { table: "email_log", column: "created_at" },
    { table: "sms_outbound_log", column: "created_at" },
    { table: "voice_call_transcripts", column: "created_at" },
    { table: "voice_outbound_dial_log", column: "created_at" },
    { table: "notifications", column: "created_at" },
    { table: "scheduled_sms", column: "send_at" },
    { table: "sms_owner_reply_prompts", column: "created_at" }
  ];
  for (const check of checks) {
    const { count, error } = await db
      .from(check.table)
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .lt(check.column, cutoffIso);
    console.log(
      `  ${check.table.padEnd(28)} ${error ? `ERROR: ${error.message}` : `<= ${count ?? 0} candidate rows (status filters apply on --apply)`}`
    );
  }
  process.exit(0);
}

console.log(`[purge] applying (keep_hours=${keepHours})...`);
const { data, error } = await db.rpc("residency_purge_business", {
  p_business: businessId,
  p_keep_hours: keepHours
});
if (error) {
  console.error(`[purge] FAILED: ${error.message}`);
  process.exit(1);
}
let total = 0;
for (const row of (data ?? []) as Array<{ table_name: string; purged: number }>) {
  total += Number(row.purged);
  console.log(`  ${row.table_name.padEnd(28)} purged ${row.purged}`);
}
console.log(`[purge] DONE — ${total} rows removed from central (history now rests on the box)`);
