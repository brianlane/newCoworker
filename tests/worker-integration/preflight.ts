/**
 * Worker-integration preflight (vitest `globalSetup`): prove the local stack is
 * actually usable before any scenario runs, so a misconfigured stack reports
 * WHAT TO DO instead of failing deep inside a test.
 *
 * The failure this exists for: a stack built from the migrations by a Supabase
 * version whose baseline no longer auto-grants the Data API roles leaves
 * `service_role` with no privileges on the pre-convention tables. Every
 * migration applies cleanly, `supabase status` hands out a valid service key,
 * and then the first seed dies with "permission denied for table
 * ai_flow_runs", which reads like a bad key rather than a missing GRANT.
 * 20260821004100_backfill_service_role_grants.sql fixes that at the schema
 * level, so the remaining way to hit it is a stack created BEFORE that
 * migration landed, which a reset repairs.
 */
import { createClient } from "@supabase/supabase-js";

const URL = (process.env.ITEST_SUPABASE_URL ?? "http://127.0.0.1:54321").replace(/\/$/, "");
const KEY = process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** Tables + one RPC the suite cannot run without. */
const TABLES = ["businesses", "ai_flows", "ai_flow_runs", "ai_flow_team_members", "contacts"];

function fail(what: string, detail: string): never {
  throw new Error(
    `Worker-integration preflight failed: ${what}\n` +
      `  ${detail}\n\n` +
      "This is the local stack, not the tests. Recreate it from the migrations:\n" +
      "  npx supabase db reset\n" +
      "then restart `supabase functions serve` and re-run. The full local recipe " +
      "is in the vitest.worker-integration.config.ts header."
  );
}

export async function setup(): Promise<void> {
  if (!KEY) {
    fail(
      "no service-role key",
      "Set ITEST_SERVICE_ROLE_KEY (see the recipe in vitest.worker-integration.config.ts)."
    );
  }
  const db = createClient(URL, KEY, { auth: { persistSession: false } });

  // Reachability first: a down stack must not read as a permissions problem.
  const { error: reachErr } = await db.from("businesses").select("id").limit(1);
  if (reachErr && /fetch failed|ECONNREFUSED|network/i.test(reachErr.message)) {
    fail(`cannot reach the local stack at ${URL}`, reachErr.message);
  }

  const denied: string[] = [];
  for (const table of TABLES) {
    const { error } = await db.from(table).select("*").limit(1);
    if (error && /permission denied/i.test(error.message)) denied.push(table);
    else if (error) fail(`could not read ${table}`, error.message);
  }
  if (denied.length > 0) {
    fail(
      `service_role has no access to ${denied.join(", ")}`,
      "The stack was built without the Data API grants the schema now states " +
        "explicitly (migration 20260821004100), so it predates that migration."
    );
  }

  // The RPC path too: function EXECUTE is granted separately from table DML, so
  // a table-only probe would miss a stack that can read but cannot call
  // anything. The probe MUST be side-effect-free, since this runs before any
  // scenario and shares the database with all of them:
  // check_sms_monthly_limit only SELECTs, and an unknown business id returns
  // `{allowed: false, reason: "no_business"}` without touching a row.
  // (claim_ai_flow_runs would be the wrong choice here: it takes a lease, and
  // `limit greatest(1, p_limit)` means even p_limit 0 flips a queued run to
  // running.) This function carries an explicit grant in its own migration, so
  // it proves the callable surface works rather than proving the backfill
  // landed; the table probe above is what detects the stale-stack case.
  const { error: rpcErr } = await db.rpc("check_sms_monthly_limit", {
    p_business_id: "00000000-0000-4000-8000-000000000000"
  });
  if (rpcErr && /permission denied|does not exist/i.test(rpcErr.message)) {
    fail("service_role cannot call RPCs (check_sms_monthly_limit)", rpcErr.message);
  }
}
