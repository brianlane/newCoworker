/**
 * One-shot: remove the broken `update` browse_action step from the
 * "Clever Lead - Accept" flow (Flow A).
 *
 * The live Clever portal proved the old selectors ("Leave an update" /
 * "Add an update") don't exist. The real "Provide Update" flow is a
 * multi-required-field form (status -> optional "scheduled a meeting?"
 * combobox -> a CLICK-BASED calendar+time picker -> notes -> Submit), which
 * fill_placeholder cannot drive. Rather than ship a last step that always
 * fails, drop it so the core flow (accept -> QT email -> route to Dave) runs
 * clean. The Clever auto-update is being built as a separate, tested change.
 *
 * Read-modify-write so we only touch the steps array. Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx debug/trim-clever-accept-update-step.ts            # dry run
 *   npx tsx debug/trim-clever-accept-update-step.ts --apply
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../src/lib/ai-flows/schema.ts"
);

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = process.env.AIFLOW_SEED_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const NAME = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Accept";
const STEP_ID_TO_REMOVE = "update";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: row, error: readErr } = await db
  .from("ai_flows")
  .select("id,enabled,definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", NAME)
  .maybeSingle();
if (readErr) {
  console.error(`Read failed: ${readErr.message}`);
  process.exit(1);
}
if (!row) {
  console.error(`No "${NAME}" flow found for business ${BUSINESS_ID}.`);
  process.exit(1);
}

const def = row.definition as { steps?: Array<{ id?: string }> };
const before = Array.isArray(def.steps) ? def.steps.length : 0;
const nextDef = {
  ...def,
  steps: (def.steps ?? []).filter((s) => s.id !== STEP_ID_TO_REMOVE)
};
const after = nextDef.steps.length;

if (after === before) {
  console.log(`No step with id="${STEP_ID_TO_REMOVE}" present; nothing to remove (steps=${before}).`);
  process.exit(0);
}

let validated;
try {
  validated = parseAiFlowDefinition(nextDef);
} catch (err) {
  if (err instanceof AiFlowValidationError) {
    console.error("Trimmed definition failed validation:");
    for (const issue of err.issues) console.error(`  - ${issue}`);
  } else {
    console.error("Trimmed definition failed validation:", err);
  }
  process.exit(2);
}

console.log(`Flow     : ${NAME} (id=${row.id}, enabled=${row.enabled})`);
console.log(`Steps    : ${before} -> ${after} (removed id="${STEP_ID_TO_REMOVE}")`);
console.log(`Summary  : ${summarizeDefinition(validated)}`);

if (!APPLY) {
  console.log("\n[dry-run] Not writing. Re-run with --apply.");
  process.exit(0);
}

const { error: updErr } = await db
  .from("ai_flows")
  .update({ definition: validated })
  .eq("id", row.id);
if (updErr) {
  console.error(`Update failed: ${updErr.message}`);
  process.exit(1);
}
console.log(`\nUpdated AiFlow id=${row.id}: removed the broken Clever update step.`);
