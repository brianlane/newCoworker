#!/usr/bin/env tsx
/**
 * One-shot: let the HomeLight referral flow wait a few minutes for the AI's
 * call to START, instead of only attaching to one already in progress.
 *
 * Background (run abcada1d, Jul 31 2026): the flow's `wait_hl_call` step is
 * configured `withinMinutes: 30, timeoutMinutes: 45`, which reads like "wait up
 * to 45 minutes for the call". It never did. `withinMinutes` is only a lookup
 * filter on voice_handoff_sessions, and `timeoutMinutes` is the ceiling on
 * waiting for a call that is ALREADY LIVE to end. With no live session the step
 * resolved "no_call" in zero seconds, so `timeoutMinutes: 45` was dead config
 * on this flow and the run sailed past a call that had not started yet.
 *
 * The engine now supports `awaitStartMinutes` (added in the same PR as this
 * script, default 0 = the old behavior, so no other flow changes). This sets it
 * to 3 on `wait_hl_call`.
 *
 * WHY 3 AND NOT 45. docs/tenants/homelight-flow.md is explicit that latency is
 * the product here. Every minute this step waits is a minute before the claimer
 * is texted the lead's details, so a long wait would be a worse bug than the
 * one being fixed. HomeLight live-transfers within a minute or two of the alert
 * or not at all, so 3 minutes covers the real case and costs almost nothing
 * when there is no call.
 *
 * Idempotent (a second run is a no-op), validates the patched definition
 * through parseAiFlowDefinition before writing, dry-run by default, and records
 * the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-await-call-start.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-await-call-start.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_FLOW_NAME (default "HomeLight Referral")
 *           HOMELIGHT_AWAIT_CALL_MINUTES (default 3)
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/** The step this patches. Named, not positional: trunk indices shift. */
export const WAIT_STEP_ID = "wait_hl_call";

/** Engine clamp is 0..60; keep the script's own ceiling well under it. */
export const MAX_AWAIT_MINUTES = 10;

type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  branches?: Array<Record<string, unknown> & { steps?: unknown }>;
  else?: unknown;
};
type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Depth-first walk over trunk steps, branch arms and else arms. */
function* walkSteps(steps: unknown): Generator<Step> {
  if (!Array.isArray(steps)) return;
  for (const step of steps as Step[]) {
    if (!step || typeof step !== "object") continue;
    yield step;
    for (const arm of Array.isArray(step.branches) ? step.branches : []) {
      yield* walkSteps(arm?.steps);
    }
    yield* walkSteps(step.else);
  }
}

/**
 * Set awaitStartMinutes on the wait_for_call step. Returns the edits made, so
 * an already-patched flow reports "nothing to do" rather than rewriting.
 */
export function patchDefinition(def: Definition, awaitMinutes: number): string[] {
  const edits: string[] = [];
  let found = false;
  for (const step of walkSteps(def.steps)) {
    if (step.id !== WAIT_STEP_ID) continue;
    found = true;
    if (step.type !== "wait_for_call") {
      throw new Error(`step "${WAIT_STEP_ID}" is a ${String(step.type)}, not a wait_for_call`);
    }
    if (step.awaitStartMinutes === awaitMinutes) break;
    step.awaitStartMinutes = awaitMinutes;
    edits.push(`${WAIT_STEP_ID}.awaitStartMinutes=${awaitMinutes}`);
    break;
  }
  if (!found) throw new Error(`no step with id "${WAIT_STEP_ID}" in this flow`);
  return edits;
}

function awaitMinutesFromEnv(): number {
  const raw = process.env.HOMELIGHT_AWAIT_CALL_MINUTES;
  if (raw === undefined || raw.trim() === "") return 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_AWAIT_MINUTES) {
    console.error(
      `HOMELIGHT_AWAIT_CALL_MINUTES must be an integer 1..${MAX_AWAIT_MINUTES} (got "${raw}"). ` +
        "This step gates every step after it, so a long wait delays the claimer's hand-off."
    );
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(2);
  }
  const businessId = args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const flowName = process.env.AIFLOW_HOMELIGHT_FLOW_NAME ?? "HomeLight Referral";
  const awaitMinutes = awaitMinutesFromEnv();

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`Flow "${flowName}" not found for business ${businessId}.`);
    process.exit(2);
  }
  const flow = row as { id: string; name: string; definition: Definition };
  const def = JSON.parse(JSON.stringify(flow.definition)) as Definition;

  let applied: string[];
  try {
    applied = patchDefinition(def, awaitMinutes);
  } catch (err) {
    console.error(
      `Unexpected shape for "${flow.name}" (${flow.id}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "The flow was rebuilt or renamed; re-read it before patching."
    );
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Flow     : ${flow.name} (${flow.id})`);
  console.log(`Wait     : ${awaitMinutes} min for the call to start`);
  if (applied.length === 0) {
    console.log("\nAlready patched, nothing to do.");
    return;
  }
  console.log(`Edits    : ${applied.join(", ")}`);

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`\nPatched "${flow.name}" would be INVALID, aborting before any write:`);
    if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
    else console.error(err);
    process.exit(2);
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
    return;
  }

  const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", flow.id);
  if (upErr) {
    console.error(`Update failed for ${flow.id}: ${upErr.message}`);
    process.exit(1);
  }
  console.log("  -> updated.");
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-await-call-start.ts",
    businessId,
    details: {
      flow_id: flow.id,
      flow_name: flow.name,
      edits: applied,
      await_start_minutes: awaitMinutes
    }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise patchDefinition against fixtures).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
