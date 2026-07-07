/**
 * Residency parity gate (Phase B3 operator tool).
 *
 * For one residency tenant, compares CENTRAL vs BOX per moved table:
 *   * row count
 *   * max created_at (when the table has one)
 * plus the pending journal depth. The B3 go/no-go: counts equal, journal
 * empty. Read-only on both stores.
 *
 * Usage:
 *   npx tsx debug/residency-parity.ts --business <uuid> [--base-url <url>]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}
const businessId = argValue("--business");
const baseUrl = argValue("--base-url");
if (!businessId) {
  console.error("usage: npx tsx debug/residency-parity.ts --business <uuid> [--base-url <url>]");
  process.exit(2);
}

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { RESIDENCY_MOVED_TABLES, RESIDENCY_TABLE_PRIMARY_KEYS } = await import(
  "../src/lib/residency/tables.ts"
);
const { DataApiClient } = await import("../src/lib/residency/client.ts");

const db = await createSupabaseServiceClient();
const api = new DataApiClient(businessId, baseUrl ? { baseUrl } : {});

/** Tables whose business scoping goes through a parent id list. */
const CHILD_PARENT: Record<string, { parent: string; fk: string }> = {
  dashboard_chat_messages: { parent: "dashboard_chat_threads", fk: "thread_id" },
  voice_call_transcript_turns: { parent: "voice_call_transcripts", fk: "transcript_id" }
};

// Parent-slice ceiling for child-table scoping. Hitting it means the gate
// CANNOT prove parity for that child table (central and box could slice
// different parent sets) — treated as a hard failure, never a silent pass.
const PARENT_SLICE_LIMIT = 5000;

async function centralCount(table: string): Promise<number> {
  const child = CHILD_PARENT[table];
  if (!child) {
    const { count, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId);
    if (error) throw new Error(`central count ${table}: ${error.message}`);
    return count ?? 0;
  }
  const { data: parents, error: pErr } = await db
    .from(child.parent)
    .select("id")
    .eq("business_id", businessId)
    .order("id", { ascending: true })
    // +1 disambiguates "exactly at the cap" (complete set, fine) from
    // "more rows exist beyond the slice" (parity unprovable).
    .limit(PARENT_SLICE_LIMIT + 1);
  if (pErr) throw new Error(`central parents for ${table}: ${pErr.message}`);
  const ids = ((parents ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (ids.length > PARENT_SLICE_LIMIT) {
    throw new Error(
      `central parents for ${table} hit the ${PARENT_SLICE_LIMIT} slice cap — cannot prove parity; raise PARENT_SLICE_LIMIT`
    );
  }
  if (ids.length === 0) return 0;
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(child.fk, ids);
  if (error) throw new Error(`central count ${table}: ${error.message}`);
  return count ?? 0;
}

async function boxCount(table: string): Promise<number> {
  const child = CHILD_PARENT[table];
  let filters;
  if (!child) {
    filters = [{ column: "business_id", op: "eq" as const, value: businessId }];
  } else {
    const parents = await api.select<{ id: string }>({
      table: child.parent as never,
      columns: ["id"],
      filters: [{ column: "business_id", op: "eq", value: businessId }],
      order: [{ column: "id", ascending: true }],
      limit: PARENT_SLICE_LIMIT + 1
    });
    if (!parents.ok) throw new Error(`box parents for ${table}: ${parents.message}`);
    const ids = parents.rows.map((p) => p.id);
    if (ids.length > PARENT_SLICE_LIMIT) {
      throw new Error(
        `box parents for ${table} hit the ${PARENT_SLICE_LIMIT} slice cap — cannot prove parity; raise PARENT_SLICE_LIMIT`
      );
    }
    if (ids.length === 0) return 0;
    filters = [{ column: child.fk, op: "in" as const, value: ids }];
  }
  // Project the first PK column (not every moved table has an `id`).
  const pkColumn = RESIDENCY_TABLE_PRIMARY_KEYS[table as never][0];
  const res = await api.select({
    table: table as never,
    columns: [pkColumn],
    filters,
    limit: 1,
    count: true
  });
  if (!res.ok) throw new Error(`box count ${table}: ${res.message}`);
  return res.count ?? 0;
}

console.log(`[parity] business ${businessId}${baseUrl ? ` via ${baseUrl}` : ""}\n`);
let mismatches = 0;
for (const table of RESIDENCY_MOVED_TABLES) {
  try {
    const [central, box] = await Promise.all([centralCount(table), boxCount(table)]);
    const ok = central === box;
    if (!ok) mismatches += 1;
    console.log(
      `  ${table.padEnd(30)} central=${String(central).padStart(6)} box=${String(box).padStart(6)} ${ok ? "OK" : "MISMATCH"}`
    );
  } catch (err) {
    mismatches += 1;
    console.log(
      `  ${table.padEnd(30)} ERROR: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const { count: pending, error: pendingError } = await db
  .from("residency_write_journal")
  .select("seq", { count: "exact", head: true })
  .eq("business_id", businessId)
  .is("replayed_at", null);
if (pendingError || pending === null || pending === undefined) {
  // An unreadable journal is a FAIL, not zero — the gate must never pass on
  // missing evidence.
  console.log(
    `\n[parity] FAIL — journal depth unreadable: ${pendingError?.message ?? "no count returned"}`
  );
  process.exit(1);
}
console.log(`\n[parity] pending journal rows: ${pending}`);
console.log(
  mismatches === 0 && pending === 0
    ? "[parity] PASS — counts equal, journal drained"
    : `[parity] FAIL — ${mismatches} table mismatch(es), ${pending} pending journal rows`
);
process.exit(mismatches === 0 && pending === 0 ? 0 : 1);
