#!/usr/bin/env tsx
/**
 * One-shot: turn on the claim-outcome EMAIL (route_to_team.claimedNotifyEmail
 * = amy@amylaidlaw.com) for Amy Laidlaw Real Estate's five lead-routing flows.
 *
 * Why (Amy's Jul 2026 question): her team watches the inbox to learn which
 * teammate owns each lead, but the flows' emails are lead-detail sends that
 * run BEFORE routing, and a LATE claim (Dave texting "1" up to 24h after the
 * window lapsed, after the "no one claimed" notice already went out) never
 * replays post-route steps, so no email ever corrected the record and leads
 * were being manually reassigned to agents when Dave already had them. The
 * engine now emails this address at CLAIM FINALIZATION: on-time claims, late
 * claims (subject says "late, after the no-claim notice"), and "86" releases.
 *
 * Deliberately excluded: "Clever - Spoke Check & Weekly Call Follow-Up" (its
 * route step is a spoke-with-the-lead confirmation, not a lead claim) and the
 * voice-routing flows (no route steps).
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent
 * (re-running detects the already-set address). Dry-run by default.
 * Records to applied_oneshots on --apply. Does NOT enqueue any runs.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-amy-claim-notify-email.ts          # dry run
 *   npx tsx scripts/oneshot/set-amy-claim-notify-email.ts --apply
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
const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const CLAIM_EMAIL = "amy@amylaidlaw.com";
const FLOW_NAMES = [
  "HomeLight Referral",
  "Realtor.com Lead",
  "ReferralExchange Lead",
  "Clever Lead - Accept",
  "New Lead Intake"
];

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

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changed: string[] } {
  const changed: string[] = [];
  const steps = structuredClone(def.steps) as unknown as AnyStep[];

  // Deep walk: route steps can live inside branch arms (New Lead Intake's
  // trunk carries four, but stay shape-proof for future edits).
  const setEmail = (list: AnyStep[]): void => {
    for (const step of list) {
      if (step.type === "route_to_team" && step.claimedNotifyEmail !== CLAIM_EMAIL) {
        step.claimedNotifyEmail = CLAIM_EMAIL;
        changed.push(`${step.id}: claimedNotifyEmail -> ${CLAIM_EMAIL}`);
      }
      if (step.type === "branch") {
        for (const arm of (step.branches as Array<{ steps: AnyStep[] }>) ?? []) {
          setEmail(arm.steps);
        }
        if (Array.isArray(step.else)) setEmail(step.else as AnyStep[]);
      }
    }
  };
  setEmail(steps);

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

const targets: Array<{ row: Row; next: AiFlowDefinition; changed: string[] }> = [];
for (const name of FLOW_NAMES) {
  const row = await loadFlow(name);
  const { next, changed } = patch(row.definition);
  targets.push({ row, next: validate(name, next), changed });
}

for (const { row, next, changed } of targets) {
  console.log(`\n=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log("  already patched, no changes");
    continue;
  }
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`  after: ${summarizeDefinition(next)}`);
}

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
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
if (patchedIds.length > 0) {
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "set-amy-claim-notify-email.ts",
    businessId: BUSINESS_ID,
    details: { flow_ids: patchedIds, claim_email: CLAIM_EMAIL }
  });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} flow(s) failed: ${failures.join(", ")}, re-run with --apply.`);
  process.exit(1);
}
console.log(
  "\nDone. No runs were enqueued; the next claim (on-time, late, or an 86 release) emails " +
    CLAIM_EMAIL +
    "."
);
