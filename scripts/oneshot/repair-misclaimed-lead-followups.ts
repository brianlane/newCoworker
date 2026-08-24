/**
 * repair-misclaimed-lead-followups.ts: restart the AI follow-up that a
 * mis-routed "1, <name>" reply cancelled.
 *
 * Background (found investigating Amy Laidlaw, 2026-08-24). A teammate replying
 * "1, <lead name>" to claim a lead used to have that name read as a claim ETA
 * whenever it matched none of their live offers, and the reply then claimed
 * their most-recently-touched offer instead. Three things followed from one
 * reply that arrived a few minutes late:
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
 * told what they actually have). This restarts the follow-up already cancelled.
 *
 * WHY IT DOES NOT RE-ASK THE TEAM. The obvious repair, rewinding to the
 * route_to_team step, asks "Did you speak with them yet?" a second time. We
 * already know the answer: the claim was fabricated by a bug, and on the run
 * that prompted this the teammate said so in writing. So the default resumes at
 * the step AFTER the route step, which is the AI follow-up the false claim
 * skipped. `--reask` restores the rewind for a case where the human answer is
 * genuinely unknown.
 *
 * CLEAR OWNERSHIP FIRST, ALWAYS. A claim also stamps
 * `contacts.owner_employee_id`, and the route step hands a lead straight back
 * to an existing owner with no claim reply ("New lead for a contact you already
 * own, so it's yours"). A first version of this script cleared the run and left
 * the ownership that run had created: all four repaired runs re-closed within
 * seconds and texted the owner the same false confirmation a second time. The
 * ownership is part of the artifact and is cleared before anything is requeued.
 *
 * EVIDENCE, NOT GUESSWORK. A run is touched only when it is `done`, carries a
 * `routing.route_step_id` rewind target, and matches one of two fingerprints:
 *
 *   A. `vars.actions_taken` records `lead claimed by <who> (ETA: <text>)` where
 *      `<text>` does not read as a timeframe by the SAME shared helper the
 *      engine now uses (`looksLikeTimeframe`). A real ETA never matches.
 *   B. `vars.actions_taken` carries this script's own repair marker AND
 *      `routing.owner_assigned` is true: a run this script already reopened
 *      that the owner-assign path then closed again. Fingerprint A cannot see
 *      those, because an owner-assign carries no ETA clause.
 *
 * A contact's ownership is cleared only when it still points at the teammate
 * the false claim named, so a lead genuinely reassigned since is left alone.
 *
 * Idempotent: a repaired run leaves `done` status, so a re-run does not see it.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv, and the
 * script is dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   # audit the whole fleet (last 14 days):
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts
 *   # scope to one tenant, one run, or widen the window:
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --business <uuid>
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --since 2026-08-01
 *   # ask the team again instead of resuming the AI follow-up:
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --reask
 *   # land it:
 *   npx tsx scripts/oneshot/repair-misclaimed-lead-followups.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import { looksLikeTimeframe } from "../../supabase/functions/_shared/ai_flows/claim_timeframe.ts";
import {
  flattenSteps,
  withResumeMarkerVar
} from "../../supabase/functions/_shared/ai_flows/branching.ts";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types.ts";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");
const REASK = process.argv.includes("--reask");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? null;
const RUN_ID = argValue("--run") ?? null;
/** Default window: recent enough that restarting a follow-up is still wanted. */
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

/** Stamped on a repaired run, and fingerprint B's first half on a re-run. */
const REPAIR_MARKER =
  "follow-up restarted: the recorded claim was a mis-routed reply " +
  "(repair-misclaimed-lead-followups.ts)";

/** Legacy marker from the first version of this script, still in live rows. */
const LEGACY_MARKER = "follow-up reopened: the recorded claim was a mis-routed reply";

/**
 * PAGED, not capped. PostgREST truncates an un-ranged select at 1000 rows and
 * reports no error, so a single `.limit(1000)` over a wide window scans the
 * OLDEST thousand runs and prints "0 to repair", which reads as "the fleet is
 * clean" when it means "we never looked at the recent half". Observed on the
 * first fleet-wide dry run of this very script.
 */
const PAGE = 500;
const rows: RunRow[] = [];
for (let from = 0; ; from += PAGE) {
  let query = db
    .from("ai_flow_runs")
    .select("id, business_id, flow_id, status, current_step, revision, updated_at, context")
    .eq("status", "done")
    .gte("updated_at", SINCE)
    .order("updated_at", { ascending: true })
    .range(from, from + PAGE - 1);
  if (BUSINESS_ID) query = query.eq("business_id", BUSINESS_ID);
  if (RUN_ID) query = query.eq("id", RUN_ID);
  const { data: page, error } = await query;
  if (error) {
    console.error(`read ai_flow_runs: ${error.message}`);
    process.exit(1);
  }
  const batch = (page ?? []) as RunRow[];
  rows.push(...batch);
  if (batch.length < PAGE) break;
}

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"}: scanned ${rows.length} completed run(s) since ` +
    `${SINCE.slice(0, 10)}${BUSINESS_ID ? ` for business ${BUSINESS_ID}` : " (whole fleet)"}, ` +
    `resuming at ${REASK ? "the route step (re-asking the team)" : "the AI follow-up"}\n`
);

/** Flattened step list per flow, so one definition is read once. */
const flatCache = new Map<string, FlowStep[]>();
async function flatStepsFor(flowId: string): Promise<FlowStep[]> {
  const cached = flatCache.get(flowId);
  if (cached) return cached;
  const { data } = await db.from("ai_flows").select("definition").eq("id", flowId).maybeSingle();
  const definition = (data as { definition?: { steps?: unknown } } | null)?.definition;
  const steps = flattenSteps(
    (Array.isArray(definition?.steps) ? definition.steps : []) as FlowStep[]
  ).map((e) => e.step);
  flatCache.set(flowId, steps);
  return steps;
}

/**
 * Make sure the lead's contact carries no owner, so a requeued run races the
 * team instead of being handed straight back to whoever the false claim named.
 *
 * Returns `ok: false` for every state we cannot positively clear, and the
 * caller then leaves the run alone: a wipe that errored, a contact we cannot
 * look up, and, deliberately, a contact owned by SOMEONE ELSE now. That last
 * one is not ours to take away, and requeuing into it would just re-close the
 * run against a different teammate.
 */
async function clearFalseContactOwner(args: {
  businessId: string;
  leadPhone: string;
  claimedBy: string;
  who: string;
}): Promise<{ ok: true; cleared: boolean } | { ok: false; reason: string }> {
  const { businessId, leadPhone, claimedBy, who } = args;
  if (!leadPhone) {
    return { ok: false, reason: "no lead phone on the run, so contact ownership cannot be checked" };
  }
  const { data: contactRow, error: readErr } = await db
    .from("contacts")
    .select("id, owner_employee_id")
    .eq("business_id", businessId)
    .eq("customer_e164", leadPhone)
    .maybeSingle();
  if (readErr) {
    return { ok: false, reason: `contact read failed: ${readErr.message}` };
  }
  const contact = contactRow as { id?: string; owner_employee_id?: string | null } | null;
  // No contact, or nobody owns it: nothing can auto-assign, nothing to clear.
  if (!contact || !contact.owner_employee_id) return { ok: true, cleared: false };

  if (!claimedBy) {
    return {
      ok: false,
      reason: `contact ${leadPhone} has an owner but the run records no claimer phone, so the owner cannot be shown to be the artifact`
    };
  }
  const { data: memberRow, error: memberErr } = await db
    .from("ai_flow_team_members")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone_e164", claimedBy)
    .maybeSingle();
  if (memberErr) {
    return { ok: false, reason: `roster read failed: ${memberErr.message}` };
  }
  const memberId = (memberRow as { id?: string } | null)?.id;
  if (!memberId || memberId !== contact.owner_employee_id) {
    return {
      ok: false,
      reason: `contact ${leadPhone} is owned by someone other than ${who} now, so the owner is not this bug's artifact and is left alone`
    };
  }
  // Dry run stops here: the predicate matched, and saying so is the whole job.
  if (!APPLY) return { ok: true, cleared: true };

  const { error: wipeErr } = await db
    .from("contacts")
    .update({ owner_employee_id: null, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("customer_e164", leadPhone)
    .eq("owner_employee_id", memberId);
  if (wipeErr) {
    return { ok: false, reason: `contact owner clear failed: ${wipeErr.message}` };
  }
  // Verify rather than trust: a PostgREST update matching zero rows returns no
  // error, and requeuing on an unverified clear is the whole failure mode.
  const { data: after, error: afterErr } = await db
    .from("contacts")
    .select("owner_employee_id")
    .eq("business_id", businessId)
    .eq("customer_e164", leadPhone)
    .maybeSingle();
  if (afterErr) {
    return { ok: false, reason: `contact re-read failed: ${afterErr.message}` };
  }
  if ((after as { owner_employee_id?: string | null } | null)?.owner_employee_id) {
    return { ok: false, reason: `contact ${leadPhone} still has an owner after the clear` };
  }
  return { ok: true, cleared: true };
}

let repaired = 0;
let skipped = 0;
let ownersCleared = 0;
const touched: Record<string, unknown>[] = [];

for (const run of rows) {
  const context = run.context ?? {};
  const vars = (context.vars ?? {}) as Record<string, unknown>;
  const routing = { ...((context.routing ?? {}) as Record<string, unknown>) };

  const actions = typeof vars.actions_taken === "string" ? vars.actions_taken : "";
  const m = CLAIM_CLAUSE.exec(actions);
  // Fingerprint A: a claim whose ETA is a name. A real ETA means a real claim,
  // and the test is the engine's own helper so the two cannot drift apart.
  const fingerprintA = m !== null && !looksLikeTimeframe(m[2].trim());
  // Fingerprint B: a run this script already reopened that the owner-assign
  // path then closed again, which carries no ETA clause to match on.
  const fingerprintB =
    (actions.includes(REPAIR_MARKER) || actions.includes(LEGACY_MARKER)) &&
    routing.owner_assigned === true;
  if (!fingerprintA && !fingerprintB) continue;

  const leadName = typeof vars.lead_name === "string" ? vars.lead_name : "(unnamed lead)";
  const leadPhone = typeof vars.lead_phone === "string" ? vars.lead_phone : "";
  const claimedName = typeof routing.claimed_name === "string" ? routing.claimed_name : "";
  const claimedBy = typeof routing.claimed_by === "string" ? routing.claimed_by : "";
  const who = claimedName || claimedBy || "a teammate";
  const typedEta = fingerprintA && m ? m[2].trim() : "";
  const routeStepId = typeof routing.route_step_id === "string" ? routing.route_step_id : "";
  const routeStepIndex =
    typeof routing.route_step_index === "number" ? routing.route_step_index : -1;

  const label = `${run.id}  (${run.updated_at.slice(0, 10)}, ${leadName})`;

  if (!routeStepId || routeStepIndex < 0) {
    console.log(
      `  SKIP ${label}: recorded as claimed by ${who}, but no route step stamped ` +
        `(routing.route_step_id/route_step_index missing), so there is no safe resume target.`
    );
    skipped++;
    continue;
  }

  // Where to pick the run back up. Default is the step AFTER the route step,
  // the AI follow-up the false claim skipped; --reask rewinds onto the route
  // step itself. Resolved from the LIVE definition through the engine's own
  // flattenSteps, so the index and the marker always agree with each other and
  // with what the worker will walk.
  const flat = await flatStepsFor(run.flow_id);
  const routeAt = flat.findIndex((s) => s.id === routeStepId);
  const resumeAt = REASK ? routeAt : routeAt + 1;
  const resumeStep = routeAt === -1 ? undefined : flat[resumeAt];
  if (!resumeStep) {
    console.log(
      `  SKIP ${label}: "${routeStepId}" ${routeAt === -1 ? "is not in the live definition" : "is the last step"}, ` +
        `so there is nothing to resume into.`
    );
    skipped++;
    continue;
  }

  console.log(
    `  ${label}\n` +
      `      recorded as claimed by ${who}` +
      `${typedEta ? `, ETA "${typedEta}" (a lead name, not a time)` : " (owner-assigned re-close of an earlier repair)"}\n` +
      `      resuming at step ${resumeAt} ("${resumeStep.id}", ${resumeStep.type})`
  );

  // OWNERSHIP FIRST, AND IT IS A PRECONDITION, NOT A BEST EFFORT. The claim
  // stamped the contact, and the route step hands a lead straight back to an
  // existing owner with no claim reply, so requeuing while an owner is still
  // on the contact simply re-closes the run. Anything short of "the contact
  // provably has no owner" skips the run instead of requeuing it.
  const ownership = await clearFalseContactOwner({
    businessId: run.business_id,
    leadPhone,
    claimedBy,
    who
  });
  if (!ownership.ok) {
    console.log(`      SKIPPED: ${ownership.reason}`);
    skipped++;
    continue;
  }
  if (ownership.cleared) {
    console.log(`      ${APPLY ? "cleared" : "would clear"} contact owner (${who}) on ${leadPhone}`);
    if (APPLY) ownersCleared++;
  }
  const clearedOwner = ownership.cleared;

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
  delete routing.owner_assigned;

  // Strip the untrue clause and say what happened instead, so the run's own
  // record stops asserting a conversation that never took place. Appended once:
  // a re-repair must not stack a second copy of the marker.
  let cleanedActions = actions.replace(CLAIM_CLAUSE_WITH_SEP, "").replace(/^; /, "");
  if (!cleanedActions.includes(REPAIR_MARKER)) cleanedActions += `; ${REPAIR_MARKER}`;

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
    resumeStep.id
  );

  touched.push({
    run_id: run.id,
    business_id: run.business_id,
    flow_id: run.flow_id,
    lead_name: leadName,
    claimed_as: who,
    ...(typedEta ? { typed_eta: typedEta } : { owner_assigned_reclose: true }),
    resumed_at_step: resumeAt,
    resumed_at_step_id: resumeStep.id,
    cleared_contact_owner: clearedOwner
  });

  if (APPLY) {
    const { data: updated, error: updateErr } = await db
      .from("ai_flow_runs")
      .update({
        status: "queued",
        current_step: resumeAt,
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
  `\n${APPLY ? `Restarted ${repaired} run(s), cleared ${ownersCleared} contact owner(s)` : `Would restart ${touched.length} run(s)`}` +
    `${skipped > 0 ? `, ${skipped} skipped with no resume target` : ""}.`
);
if (!APPLY) {
  console.log("Re-run with --apply to land it.");
} else if (repaired > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "repair-misclaimed-lead-followups.ts",
    businessId: BUSINESS_ID,
    details: { repaired, skipped, owners_cleared: ownersCleared, reask: REASK, runs: touched }
  });
}
