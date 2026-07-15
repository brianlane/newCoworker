/**
 * Reset the NCW Flow Test tenant between scenarios: DELETE its finished
 * ai_flow_runs (steps cascade) so the duplicate-lead guard treats the
 * tester's next submission as a fresh lead.
 *
 * Why delete instead of aging updated_at out of the 72h window: the runs
 * table carries an updated_at touch trigger, so a PostgREST update gets
 * re-stamped to now() and the "aged" run keeps suppressing the next
 * scenario (observed live 2026-07-14). Deletion has no such trap, and on
 * the throwaway test tenant the run history has no other consumer.
 *
 * Live/parked runs (queued/awaiting_*) are left alone by default so an
 * in-flight scenario can't be yanked mid-conversation; pass --all to
 * delete those too.
 *
 * Usage:
 *   tsx debug/flow-test-reset.ts          # delete finished runs
 *   tsx debug/flow-test-reset.ts --all    # delete every run, any status
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const TEST_BUSINESS_ID = "f1047e50-0000-4000-8000-000000000001";
const ALL = process.argv.includes("--all");

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

let query = db.from("ai_flow_runs").delete().eq("business_id", TEST_BUSINESS_ID);
if (!ALL) query = query.in("status", ["done", "failed", "canceled"]);
const { data, error } = await query.select("id, status");
if (error) throw new Error(error.message);
const rows = (data ?? []) as Array<{ id: string; status: string }>;
console.log(
  `deleted ${rows.length} run(s)${ALL ? " (all statuses)" : " (finished only)"} — ` +
    "next kickoff runs as a fresh lead"
);
for (const r of rows) console.log(`  - ${r.id} (${r.status})`);
