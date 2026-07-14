#!/usr/bin/env tsx
/**
 * One-shot: fix the renewal-answer dead window in Truly Insurance's Privyr
 * lead-intake flows (the 2026-07-14 "Alex" incident, run 5820f7f0).
 *
 * The intent_fork else-arm asked "when does your current policy renew?" and
 * then IMMEDIATELY parked on route_to_team's agent-offer window; the
 * wait_renewal step (added after the 2026-07-11 incident) sits AFTER the
 * route step, so it only starts once the offer resolves. Alex answered
 * "July 23, 2026" sixteen seconds after the question — the run was
 * awaiting_agent, no wait was listening, the answer fell to the generic AI
 * path ("I'm sorry, I need a bit more context…"), and wait_renewal later
 * timed out to no_reply. The policy DEADLINE never reached the broker.
 *
 * Replayed and pinned by tests/e2e/truly-renewal-context.e2e.test.ts
 * (walkFlowTimed models the route_to_team park; the test fails against the
 * pre-patch ordering and passes against the shape this oneshot writes).
 *
 * The patch, per flow that has the renewal question:
 *  1. Reorder the else-arm to: continue_convo → tag_engaged → wait_renewal →
 *     renewal_ack → offer_team. The lead's answer is consumed by the wait
 *     (suppressing the generic path for that turn), acknowledged, and THEN
 *     the broker offer goes out.
 *  2. wait_renewal timeout becomes 30 minutes (was 240). In its old
 *     position the timeout delayed nothing; ahead of the route it gates
 *     broker outreach, and an SMS answer to a direct question lands within
 *     minutes or not at all — 30 keeps silent-lead broker latency bounded.
 *  3. The offer template carries the captured answer
 *     (`Renewal: "{{vars.renewal_timing}}"`) so the broker sees the
 *     deadline before claiming ("no_reply" when the wait timed out).
 *  4. Flows missing wait_renewal entirely (the disabled original) get the
 *     wait + ack inserted in the correct position.
 *
 * Also (apply-time, once): pins the incident's lost fact on Alex's contact
 * — "Policy renews July 23, 2026" — so the broker handling the still-open
 * run 5820f7f0 finally has the deadline the thread dropped.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent
 * (re-running detects the already-patched shape). Dry-run by default.
 * Records to applied_oneshots on --apply. Does NOT enqueue any runs. The
 * public library template (lead-intake-follow-up-privyr) is refreshed
 * hourly from tenant flows, so it inherits the fix without a manual write.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-truly-renewal-wait-order.ts          # dry run
 *   npx tsx scripts/oneshot/patch-truly-renewal-wait-order.ts --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
import type { AiFlowDefinition, FlowStep } from "../../src/lib/ai-flows/schema.ts";

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = "690f85c0-ee16-4ee5-bde5-5829df2e5410"; // Truly Insurance
const FLOW_NAMES = [
  "Lead intake & follow-up (Privyr) (copy)", // enabled, live
  "Lead intake & follow-up (Privyr)" // disabled original, kept consistent
];

/** Alex, the incident lead — the fact the dropped turn should have captured. */
const ALEX_E164 = "+15199560528";
const ALEX_PINNED_FACT =
  "Auto policy renews July 23, 2026 (their SMS answer on 2026-07-14; " +
  "the automated thread dropped it — recovered manually).";

const WAIT_RENEWAL_TIMEOUT_MINUTES = 30;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = { id: string; name: string; enabled: boolean; definition: AiFlowDefinition };
type AnyStep = Record<string, unknown>;

async function loadFlow(name: string): Promise<Row> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`read "${name}": ${error.message}`);
  if (!data) throw new Error(`no "${name}" flow for business ${BUSINESS_ID}`);
  return data as Row;
}

const QUIET_HOURS = {
  timezone: "America/New_York",
  resumeAt: "08:00",
  noSendAfter: "21:00"
};

function buildWaitRenewal(): AnyStep {
  return {
    id: "wait_renewal",
    type: "wait_for_reply",
    saveAs: "renewal_timing",
    phoneVar: "lead_phone",
    timeoutMinutes: WAIT_RENEWAL_TIMEOUT_MINUTES
  };
}

function buildRenewalAck(): AnyStep {
  return {
    id: "renewal_ack",
    type: "send_sms",
    to: "{{vars.lead_phone}}",
    body:
      "Perfect, thank you {{vars.lead_name}} — I've noted that for your broker. " +
      "One of our licensed brokers will reach out shortly to review your options. " +
      "If a specific day or time works best for a call, just reply here and let me know.",
    when: { var: "renewal_timing", notEquals: "no_reply" },
    quietHours: QUIET_HOURS
  };
}

/**
 * Rebuild one intent_fork else-arm into the fixed order. Returns null when
 * the arm doesn't contain the renewal-question + route pair (not the arm
 * we're fixing), or when it is already in the fixed shape.
 */
function fixElseArm(elseSteps: AnyStep[]): { next: AnyStep[]; note: string } | null {
  const ids = elseSteps.map((s) => String(s.id));
  const continueIdx = ids.indexOf("continue_convo");
  const offerIdx = ids.indexOf("offer_team");
  if (continueIdx === -1 || offerIdx === -1) return null;

  const waitIdx = ids.indexOf("wait_renewal");
  const ackIdx = ids.indexOf("renewal_ack");
  const alreadyOrdered = waitIdx !== -1 && waitIdx < offerIdx && ackIdx !== -1 && ackIdx < offerIdx;

  const offer = elseSteps[offerIdx];
  const offerTemplate = String(offer.offerTemplate ?? "");
  const offerNeedsRenewal = !offerTemplate.includes("{{vars.renewal_timing}}");
  const wait = waitIdx === -1 ? buildWaitRenewal() : elseSteps[waitIdx];
  const timeoutNeedsCap =
    Number(wait.timeoutMinutes ?? 0) !== WAIT_RENEWAL_TIMEOUT_MINUTES;

  if (alreadyOrdered && !offerNeedsRenewal && !timeoutNeedsCap) return null;

  wait.timeoutMinutes = WAIT_RENEWAL_TIMEOUT_MINUTES;
  if (offerNeedsRenewal) {
    // Insert ahead of the trailing claim instruction so the deadline reads
    // as part of the lead summary, not an afterthought.
    offer.offerTemplate = offerTemplate.replace(
      / Reply 1 to claim/,
      ' Renewal: "{{vars.renewal_timing}}". Reply 1 to claim'
    );
    if (!String(offer.offerTemplate).includes("{{vars.renewal_timing}}")) {
      // Template didn't match the expected claim phrasing — append instead.
      offer.offerTemplate = `${offerTemplate} Renewal: "{{vars.renewal_timing}}".`;
    }
  }
  const ack = ackIdx === -1 ? buildRenewalAck() : elseSteps[ackIdx];

  const rest = elseSteps.filter(
    (s) => !["continue_convo", "wait_renewal", "renewal_ack", "offer_team"].includes(String(s.id))
  );
  // Fixed order: question → (remaining steps, e.g. tag_engaged) → wait →
  // ack → route. The remaining steps are zero-cost CRM writes; keeping them
  // before the wait preserves their original "right after the question"
  // timing.
  const next = [elseSteps[continueIdx], ...rest, wait, ack, offer];
  const notes = [
    waitIdx === -1 ? "wait_renewal inserted" : "wait_renewal reordered before offer_team",
    `timeout ${WAIT_RENEWAL_TIMEOUT_MINUTES}m`,
    ...(ackIdx === -1 ? ["renewal_ack inserted"] : []),
    ...(offerNeedsRenewal ? ["offer carries renewal answer"] : [])
  ];
  return { next, note: notes.join(", ") };
}

/** Deep-walk every branch step looking for the intent_fork else-arm. */
function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: string[] } {
  const changed: string[] = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  const walk = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.type !== "branch") continue;
      if (Array.isArray(step.else)) {
        const fixed = fixElseArm(step.else as AnyStep[]);
        if (fixed) {
          step.else = fixed.next;
          changed.push(`${step.id} else-arm: ${fixed.note}`);
        } else {
          walk(step.else as AnyStep[]);
        }
      }
      for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) {
        walk(arm.steps);
      }
    }
  };
  walk(steps);

  return { next: { ...def, steps: steps as unknown as FlowStep[] }, changed };
}

function validate(name: string, nextDef: unknown): AiFlowDefinition {
  try {
    return parseAiFlowDefinition(nextDef);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`"${name}" failed validation:`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(`"${name}" failed validation:`, err);
    }
    process.exit(2);
  }
}

/** Pin the recovered renewal fact on Alex's contact (idempotent). */
async function pinAlexRenewalFact(): Promise<string> {
  const { data, error } = await db
    .from("contacts")
    .select("id, pinned_md")
    .eq("business_id", BUSINESS_ID)
    .eq("customer_e164", ALEX_E164)
    .maybeSingle();
  if (error) return `pin skipped: contact read failed (${error.message})`;
  if (!data) return "pin skipped: Alex contact not found";
  const pinned = ((data as { pinned_md?: string | null }).pinned_md ?? "").trim();
  if (pinned.includes("renews July 23, 2026")) return "pin already present";
  const next = pinned ? `${pinned}\n- ${ALEX_PINNED_FACT}` : `- ${ALEX_PINNED_FACT}`;
  const { error: upErr } = await db
    .from("contacts")
    .update({ pinned_md: next, updated_at: new Date().toISOString() })
    .eq("id", (data as { id: string }).id);
  if (upErr) return `pin failed: ${upErr.message}`;
  return "pinned renewal fact on Alex's contact";
}

const targets: Array<{ row: Row; next: AiFlowDefinition; changed: string[] }> = [];
for (const name of FLOW_NAMES) {
  const row = await loadFlow(name);
  const { next, changed } = patch(row.definition);
  targets.push({ row, next: validate(name, next), changed });
}

for (const { row, next, changed } of targets) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log("  already patched — no changes");
    continue;
  }
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`  after: ${summarizeDefinition(next)}`);
}

if (!APPLY) {
  console.log(`\n[dry-run] Would also pin on Alex (${ALEX_E164}): "${ALEX_PINNED_FACT}"`);
  console.log("[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

const failures: string[] = [];
const patchedIds: string[] = [];
for (const { row, next, changed } of targets) {
  if (changed.length === 0) continue;
  const { error } = await db.from("ai_flows").update({ definition: next }).eq("id", row.id);
  if (error) {
    console.error(`update "${row.name}" (id=${row.id}) failed: ${error.message}`);
    failures.push(row.name);
    continue;
  }
  patchedIds.push(row.id);
  console.log(`Updated "${row.name}" (id=${row.id}).`);
}

console.log(await pinAlexRenewalFact());

if (patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-truly-renewal-wait-order.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds, wait_timeout_minutes: WAIT_RENEWAL_TIMEOUT_MINUTES }
  });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} flow(s) failed: ${failures.join(", ")} — re-run with --apply.`);
  process.exit(1);
}
console.log("\nDone. No runs were enqueued; the next Privyr lead exercises the fixed ordering.");
