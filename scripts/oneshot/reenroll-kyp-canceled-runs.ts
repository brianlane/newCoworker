/**
 * reenroll-kyp-canceled-runs.ts — resume lead-nurture runs that were canceled
 * by a mid-run flow edit (parked step removed), WITHOUT repeating any text
 * the lead already received.
 *
 * Background (Jul 22 2026, KYP Ads): an evening edit to "Lead follow-up
 * (white-glove build)" replaced the branch-arm step ids (s100_ / s200_) with
 * a linear sequence (s_wait_ / s_nudge_). Four real leads' runs were parked
 * on the removed steps, so the engine's resume-by-step-id safety canceled
 * them ("flow edited mid-run and its parked step was removed") — correct
 * behavior, but those leads silently dropped out of the cadence.
 *
 * This script re-creates each canceled run as a NEW queued run positioned at
 * the equivalent step of the CURRENT definition, derived from the reply vars
 * the old run already recorded:
 *
 *   reply_final == no_reply             → resume at the owner wrap-up step
 *                                         (notify owner + mark Inactive; zero
 *                                         further texts to the lead)
 *   reply_N == no_reply, reply_{N+1}    → resume at nudge N+1 (the next unsent
 *   not yet recorded                      text in the cadence)
 *   any reply var with a real reply     → SKIP (the lead engaged; a human/AI
 *                                         thread exists — never re-automate)
 *
 * Repeat guard: the resume position implies how many texts the lead must have
 * already received (greeting + sent nudges); the script counts the old run's
 * actual sends in sms_outbound_log and SKIPS on any mismatch. It also skips
 * leads that already have another live run of this flow.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/reenroll-kyp-canceled-runs.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/reenroll-kyp-canceled-runs.ts --business <uuid> --apply  # write
 *   (optional) --flow-name "<name>"  --since <iso date, default 2026-07-22>
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? process.env.KYP_BUSINESS_ID;
const FLOW_NAME = argValue("--flow-name") ?? "Lead follow-up (white-glove build)";
const SINCE = argValue("--since") ?? "2026-07-22";

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// Load the flow's CURRENT definition and locate the cadence steps by shape
// (send_sms nudges gated on reply_N, the reply_final-gated notify_owner
// wrap-up) so the mapping survives cosmetic step-id changes.
// ---------------------------------------------------------------------------
const { data: flowRow, error: flowErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (flowErr || !flowRow) {
  console.error("[oneshot] flow read failed:", flowErr?.message ?? "not found");
  process.exit(1);
}

type Step = {
  id: string;
  type: string;
  when?: { var?: string; equals?: string };
};
const steps = ((flowRow.definition as { steps?: Step[] }).steps ?? []) as Step[];

/** Index of the send_sms nudge whose `when` gate reads the given reply var. */
function nudgeIndexFor(replyVar: string): number {
  return steps.findIndex(
    (s) => s.type === "send_sms" && s.when?.var === replyVar && s.when?.equals === "no_reply"
  );
}
const wrapUpIndex = steps.findIndex(
  (s) => s.type === "notify_owner" && s.when?.var === "reply_final" && s.when?.equals === "no_reply"
);
if (wrapUpIndex === -1) {
  console.error("[oneshot] current definition has no reply_final-gated notify_owner wrap-up step");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Canceled runs to consider.
// ---------------------------------------------------------------------------
const { data: canceledRows, error: runsErr } = await db
  .from("ai_flow_runs")
  .select("id, status, context, last_error, created_at, updated_at")
  .eq("business_id", BUSINESS_ID)
  .eq("flow_id", flowRow.id)
  .eq("status", "canceled")
  .gte("updated_at", SINCE)
  .ilike("last_error", "%flow was edited%");
if (runsErr) {
  console.error("[oneshot] canceled-run listing failed:", runsErr.message);
  process.exit(1);
}

type RunRow = {
  id: string;
  context: {
    vars?: Record<string, string>;
    trigger?: Record<string, unknown>;
  };
  created_at: string;
};
const canceled = (canceledRows ?? []) as RunRow[];
if (canceled.length === 0) {
  console.log("[oneshot] no edit-canceled runs found — nothing to do.");
  process.exit(0);
}

type Plan = {
  runId: string;
  leadName: string;
  leadPhone: string;
  resumeIndex: number;
  resumeStepId: string;
  expectedPriorSends: number;
  actualPriorSends: number;
  nextAction: string;
  vars: Record<string, string>;
  trigger: Record<string, unknown>;
};
const plans: Plan[] = [];
const skips: Array<{ runId: string; leadName: string; reason: string }> = [];

const NO_REPLY = "no_reply";
/** Ordered cadence: reply var of each wait, and the nudge var count implied. */
const REPLY_VARS = ["reply_1", "reply_2", "reply_3", "reply_final"] as const;

for (const run of canceled) {
  const vars = { ...(run.context.vars ?? {}) };
  const trigger = run.context.trigger ?? {};
  const leadName = vars.lead_name ?? "(unknown)";
  const leadPhone = vars.lead_phone ?? "";
  if (!/^\+\d{8,15}$/.test(leadPhone)) {
    skips.push({ runId: run.id, leadName, reason: "no usable lead phone in run vars" });
    continue;
  }

  // A lead who actually REPLIED must never be re-automated.
  const engaged = REPLY_VARS.some((v) => typeof vars[v] === "string" && vars[v] !== NO_REPLY);
  if (engaged) {
    skips.push({ runId: run.id, leadName, reason: "lead replied at some point — leave to humans" });
    continue;
  }

  // Position: reply_final recorded → wrap-up only. Otherwise the first
  // wait whose reply var is UNRECORDED marks the next unsent nudge.
  let resumeIndex: number;
  let nextAction: string;
  let expectedPriorSends: number; // greeting + nudges already sent
  if (vars.reply_final === NO_REPLY) {
    resumeIndex = wrapUpIndex;
    nextAction = "notify owner + mark Inactive (no further texts to the lead)";
    expectedPriorSends = 4; // greeting + 3 nudges
  } else {
    const recorded = REPLY_VARS.filter((v) => vars[v] === NO_REPLY).length;
    if (recorded === 0) {
      skips.push({ runId: run.id, leadName, reason: "no reply vars recorded — position unclear" });
      continue;
    }
    // recorded no_reply waits 1..N → nudge N is the next unsent text.
    const nudgeVar = REPLY_VARS[recorded - 1];
    resumeIndex = nudgeIndexFor(nudgeVar);
    if (resumeIndex === -1) {
      skips.push({ runId: run.id, leadName, reason: `no nudge gated on ${nudgeVar} in current def` });
      continue;
    }
    nextAction = `send the next cadence text (nudge gated on ${nudgeVar}), then keep waiting`;
    expectedPriorSends = 1 + (recorded - 1); // greeting + nudges before this one
  }

  // Repeat guard 1: the old run's REAL send count must match the position.
  const { count: sendCount, error: sendErr } = await db
    .from("sms_outbound_log")
    .select("id", { count: "exact", head: true })
    .eq("business_id", BUSINESS_ID)
    .eq("run_id", run.id)
    .eq("to_e164", leadPhone);
  if (sendErr) {
    skips.push({ runId: run.id, leadName, reason: `send-count read failed: ${sendErr.message}` });
    continue;
  }
  const actualPriorSends = sendCount ?? 0;
  if (actualPriorSends !== expectedPriorSends) {
    skips.push({
      runId: run.id,
      leadName,
      reason: `send-count mismatch (expected ${expectedPriorSends} prior texts, found ${actualPriorSends}) — resolve by hand`
    });
    continue;
  }

  // Repeat guard 2: no other live run of this flow for the same lead.
  const { data: liveRows, error: liveErr } = await db
    .from("ai_flow_runs")
    .select("id, status, context")
    .eq("business_id", BUSINESS_ID)
    .eq("flow_id", flowRow.id)
    .in("status", ["queued", "running", "awaiting_reply", "awaiting_agent", "awaiting_approval"]);
  if (liveErr) {
    skips.push({ runId: run.id, leadName, reason: `live-run read failed: ${liveErr.message}` });
    continue;
  }
  const liveForLead = (
    (liveRows ?? []) as Array<{ context: { vars?: Record<string, string> } }>
  ).some((r) => (r.context.vars?.lead_phone ?? "") === leadPhone);
  if (liveForLead) {
    skips.push({ runId: run.id, leadName, reason: "another live run already covers this lead" });
    continue;
  }

  // Repeat guard 3 (idempotency): this script already re-enrolled this run.
  const { data: dupRow } = await db
    .from("ai_flow_runs")
    .select("id")
    .eq("business_id", BUSINESS_ID)
    .eq("dedupe_key", `reenroll:${run.id}`)
    .maybeSingle();
  if (dupRow) {
    skips.push({ runId: run.id, leadName, reason: "already re-enrolled by a previous apply" });
    continue;
  }

  const resumeStepId = steps[resumeIndex].id;
  vars.__resume_step_id = resumeStepId;
  plans.push({
    runId: run.id,
    leadName,
    leadPhone,
    resumeIndex,
    resumeStepId,
    expectedPriorSends,
    actualPriorSends,
    nextAction,
    vars,
    trigger
  });
}

console.log(`[oneshot] flow "${flowRow.name}" — ${canceled.length} edit-canceled run(s) examined`);
for (const s of skips) {
  console.log(`[oneshot] skip   ${s.leadName} (run ${s.runId}): ${s.reason}`);
}
for (const p of plans) {
  console.log(
    `[oneshot] resume ${p.leadName} ${p.leadPhone}: ${p.actualPriorSends} text(s) already sent → ` +
      `step "${p.resumeStepId}" (#${p.resumeIndex}) — ${p.nextAction}`
  );
}

if (plans.length === 0) {
  console.log("[oneshot] nothing to re-enroll.");
  process.exit(0);
}
if (!APPLY) {
  console.log(
    `[oneshot] dry run complete (${plans.length} run(s) would be re-created). Re-run with --apply to write.`
  );
  process.exit(0);
}

const created: Array<{ old_run_id: string; new_run_id: string; lead: string; resume_step: string }> = [];
for (const p of plans) {
  const { data: newRun, error: insErr } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: flowRow.id,
      business_id: BUSINESS_ID,
      status: "queued",
      context: { trigger: p.trigger, vars: p.vars },
      current_step: p.resumeIndex,
      dedupe_key: `reenroll:${p.runId}`
    })
    .select("id")
    .single();
  if (insErr || !newRun) {
    console.error(`[oneshot] insert failed for ${p.leadName}:`, insErr?.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  ${p.leadName} → run ${newRun.id} parked-to-resume at "${p.resumeStepId}"`);
  created.push({
    old_run_id: p.runId,
    new_run_id: newRun.id as string,
    lead: p.leadName,
    resume_step: p.resumeStepId
  });
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { flow_id: flowRow.id, flow_name: flowRow.name, reenrolled: created }
});
console.log("[oneshot] applied.");
