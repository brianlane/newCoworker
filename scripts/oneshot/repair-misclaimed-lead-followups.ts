/**
 * repair-misclaimed-lead-followups.ts: reopen the follow-up ladders that a
 * mis-routed "1, <name>" reply closed.
 *
 * Background (found investigating Amy Laidlaw, 2026-08-24). A teammate replying
 * "1, <lead name>" to claim a lead used to have that name read as a claim ETA
 * whenever it matched none of their live offers, and the reply then claimed
 * their most-recently-touched offer instead. Three things followed from one
 * mistyped-looking reply:
 *
 *   - the owner was texted "<teammate> confirmed they spoke with <lead>" about
 *     a lead that teammate had never heard of,
 *   - `claimed_agent` was set, so every AI follow-up step gated on
 *     `claimed_agent == "none"` was skipped and the run completed, and
 *     nobody, human or AI, was left following the lead up,
 *   - the notice carried "ETA to contact lead: <the typed name>", which is the
 *     fingerprint this script matches on.
 *
 * The engine no longer does this (the reply is refused and the teammate is
 * told what they actually have). This reopens the runs already closed by it.
 *
 * EVIDENCE, NOT GUESSWORK. A run is touched only when all of these hold:
 *
 *   - `vars.actions_taken` records `lead claimed by <who> (ETA: <text>)` and
 *     `<text>` does not read as a timeframe by the SAME shared helper the
 *     engine now uses (`looksLikeTimeframe`). A real ETA never matches.
 *   - the run is `done`: a live run is still doing whatever it is doing.
 *   - `routing.route_step_id` is stamped, so there is a known rewind target.
 *     Without it the run is reported and skipped rather than guessed at.
 *
 * What a repair does, mirroring the webhook's own late-claim rewind: clears the
 * false claim off `routing`, resets the `claimed_agent*` vars to "none", moves
 * the run back to its route step with a matching resume marker, and requeues
 * it. The engine then does exactly what it would have done: re-ask the
 * teammate, and start the AI follow-up when no one answers. `tried` and
 * `offered_log` are deliberately LEFT ALONE, they are the true record of who
 * was asked, and clearing them would re-offer a lead to someone who already
 * declined it.
 *
 * Idempotent: a repaired run no longer carries the claim clause, so a re-run
 * skips it.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv, and the
 * script is dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   # audit the whole fleet (last 14 days):
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts
 *   # scope to one tenant, or widen the window:
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --business <uuid>
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --since 2026-08-01
 *   # land it:
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import { looksLikeTimeframe } from "../../supabase/functions/_shared/ai_flows/claim_timeframe.ts";
import { withResumeMarkerVar } from "../../supabase/functions/_shared/ai_flows/branching.ts";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? null;
const RUN_ID = argValue("--run") ?? null;
/** Default window: recent enough that reopening a ladder is still wanted. */
const SINCE =
  argValue("--since") ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

type RunRow = {
  id: string;
  business_id: string;
  flow_id: string;
  status: string;
  current_step: number;
  revision: number;
  updated_at: string;
  context: Record<string, unknown> | null;
};

/**
 * The claim clause the bug leaves in `actions_taken`, e.g.
 * `lead claimed by Jason Lane (ETA: Sandy)`. The ETA group is what gets tested
 * against `looksLikeTimeframe`.
 */
const CLAIM_CLAUSE = /lead claimed by ([^(;]*)\(ETA: ([^)]*)\)/;

/** The clause plus its trailing separator, so removing it leaves clean prose. */
const CLAIM_CLAUSE_WITH_SEP = /(?:; )?lead claimed by [^(;]*\(ETA: [^)]*\)/;

let query = db
  .from("ai_flow_runs")
  .select("id, business_id, flow_id, status, current_step, revision, updated_at, context")
  .eq("status", "done")
  .gte("updated_at", SINCE)
  // Bound explicitly: an un-limited PostgREST select silently truncates at
  // 1000 rows, which would read as "nothing left to repair".
  .limit(1000)
  .order("updated_at", { ascending: true });
if (BUSINESS_ID) query = query.eq("business_id", BUSINESS_ID);
if (RUN_ID) query = query.eq("id", RUN_ID);

const { data: rows, error } = await query;
if (error) {
  console.error(`read ai_flow_runs: ${error.message}`);
  process.exit(1);
}

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: scanned ${(rows ?? []).length} completed run(s) since ` +
    `${SINCE.slice(0, 10)}${BUSINESS_ID ? ` for business ${BUSINESS_ID}` : " (whole fleet)"}\n`
);

let repaired = 0;
let skipped = 0;
const touched: Record<string, unknown>[] = [];

for (const run of (rows ?? []) as RunRow[]) {
  const context = run.context ?? {};
  const vars = (context.vars ?? {}) as Record<string, unknown>;
  const routing = { ...((context.routing ?? {}) as Record<string, unknown>) };

  const actions = typeof vars.actions_taken === "string" ? vars.actions_taken : "";
  const m = CLAIM_CLAUSE.exec(actions);
  if (!m) continue;
  const typedEta = m[2].trim();
  // A real ETA means a real claim. Only a non-timeframe in the ETA slot is the
  // artifact, and it is tested by the engine's own helper so the two can never
  // drift apart.
  if (looksLikeTimeframe(typedEta)) continue;

  const leadName = typeof vars.lead_name === "string" ? vars.lead_name : "(unnamed lead)";
  const claimedName = typeof routing.claimed_name === "string" ? routing.claimed_name : "";
  const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
  const who = claimedName || claimedBy || "a teammate";
  const routeStepId = typeof routing.route_step_id === "string" ? routing.route_step_id : "";
  const routeStepIndex =
    typeof routing.route_step_index === "number" ? routing.route_step_index : -1;

  const label = `${run.id}  (${run.updated_at.slice(0, 10)}, ${leadName})`;

  if (!routeStepId || routeStepIndex < 0) {
    console.log(
      `  SKIP ${label}: claimed by ${who} with ETA "${typedEta}", but no route step stamped ` +
        `(routing.route_step_id/route_step_index missing), so there is no safe rewind target.`
    );
    skipped++;
    continue;
  }

  console.log(
    `  ${label}\n` +
      `      recorded as claimed by ${who}, ETA "${typedEta}" (a lead name, not a time)\n` +
      `      reopening at step ${routeStepIndex} ("${routeStepId}")`
  );

  // Clear the false claim. `tried` / `offered_log` stay: they record who was
  // actually asked, and the engine reads them to avoid re-offering a lead to
  // someone who already passed.
  delete routing.claimed_by;
  delete routing.claimed_name;
  delete routing.claimed_at_ms;
  delete routing.claim_timeframe;
  delete routing.late_claimed;
  delete routing.last_event;
  delete routing.reply_from;

  // Strip the untrue clause and say what happened instead, so the run's own
  // record stops asserting a conversation that never took place.
  const cleanedActions =
    actions.replace(CLAIM_CLAUSE_WITH_SEP, "").replace(/^; /, "") +
    "; follow-up reopened: the recorded claim was a mis-routed reply " +
    "(repair-misclaimed-lead-followups.ts)";

  const nextContext = withResumeMarkerVar(
    {
      ...context,
      routing,
      vars: {
        ...vars,
        actions_taken: cleanedActions,
        claimed_agent: "none",
        claimed_agent_phone: "none",
        claimed_agent_eta_minutes: "0"
      }
    },
    routeStepId
  );

  touched.push({
    run_id: run.id,
    business_id: run.business_id,
    flow_id: run.flow_id,
    lead_name: leadName,
    claimed_as: who,
    typed_eta: typedEta,
    reopened_at_step: routeStepIndex
  });

  if (APPLY) {
    const { data: updated, error: updateErr } = await db
      .from("ai_flow_runs")
      .update({
        status: "queued",
        current_step: routeStepIndex,
        awaiting_agent_e164: null,
        respond_by_at: null,
        context: nextContext,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      // Optimistic concurrency: a trigger bumps `revision` on every update, so
      // gating on the one we read means a run the worker touched meanwhile is
      // left alone rather than overwritten with this stale snapshot.
      .eq("revision", run.revision)
      .eq("status", "done")
      .select("id");
    if (updateErr) {
      console.error(`      update failed: ${updateErr.message}`);
      continue;
    }
    // A PostgREST update matching zero rows returns no error, so confirm the
    // write landed rather than trusting the absence of one.
    if ((updated ?? []).length === 0) {
      console.error(`      update matched no rows (run changed underneath us); left alone`);
      continue;
    }
    repaired++;
  }
}

console.log(
  `\n${APPLY ? `Reopened ${repaired} run(s)` : `Would reopen ${touched.length} run(s)`}` +
    `${skipped > 0 ? `, ${skipped} skipped with no rewind target` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to land it.");
} else if (repaired > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "repair-misclaimed-lead-followups.ts",
    businessId: BUSINESS_ID,
    details: { repaired, skipped, runs: touched }
  });
}
