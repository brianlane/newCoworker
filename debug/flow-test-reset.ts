/**
 * Reset the flow-test harness between scenarios: DELETE the TEST flow's
 * finished ai_flow_runs (steps cascade) so the duplicate-lead guard treats
 * the tester's next submission as a fresh lead.
 *
 * Scoped to the TEST COPY flow's runs ONLY. The harness now lives on the
 * long-lived "New Coworker (HQ, internal)" tenant (homepage demo line + site
 * webchat), so a business-wide delete would destroy real run history —
 * unlike the old throwaway NCW Flow Test tenant this replaced.
 *
 * Why delete instead of aging updated_at out of the 72h window: the runs
 * table carries an updated_at touch trigger, so a PostgREST update gets
 * re-stamped to now() and the "aged" run keeps suppressing the next
 * scenario (observed live 2026-07-14). Deletion has no such trap.
 *
 * Live/parked runs (queued/awaiting_*) are left alone by default so an
 * in-flight scenario can't be yanked mid-conversation; pass --all to
 * delete those too.
 *
 * Usage:
 *   tsx debug/flow-test-reset.ts          # delete the test flow's finished runs
 *   tsx debug/flow-test-reset.ts --all    # delete the test flow's runs, any status
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

/** New Coworker (HQ, internal) — the single internal smoke/e2e tenant. */
const TEST_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAME = "Lead intake & follow-up (Privyr) (TEST COPY of Truly)";
const ALL = process.argv.includes("--all");

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: flow, error: flowErr } = await db
  .from("ai_flows")
  .select("id")
  .eq("business_id", TEST_BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (flowErr) throw new Error(`flow lookup: ${flowErr.message}`);
if (!flow) {
  console.log("test flow not found — nothing to reset (run flow-test-setup.ts first)");
  process.exit(0);
}

let query = db
  .from("ai_flow_runs")
  .delete()
  .eq("business_id", TEST_BUSINESS_ID)
  .eq("flow_id", (flow as { id: string }).id);
if (!ALL) query = query.in("status", ["done", "failed", "canceled"]);
const { data, error } = await query.select("id, status");
if (error) throw new Error(error.message);
const rows = (data ?? []) as Array<{ id: string; status: string }>;
console.log(
  `deleted ${rows.length} test-flow run(s)${ALL ? " (all statuses)" : " (finished only)"} — ` +
    "next kickoff runs as a fresh lead"
);
for (const r of rows) console.log(`  - ${r.id} (${r.status})`);
