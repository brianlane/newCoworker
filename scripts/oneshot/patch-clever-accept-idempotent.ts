#!/usr/bin/env tsx
/**
 * One-shot: make "Clever Lead - Accept" survive an accept that already worked.
 *
 * On 2026-08-04 the flow walked Clever's accept wizard to completion, the
 * referral WAS accepted, and the run was dead-lettered anyway. The finished
 * wizard left its "Next" button visible but inert, `locator.click` burned its
 * 10s timeout, and `action_failed` is classified permanent. 19 downstream steps
 * never ran, so a $225K seller (Joseph L Blasko, Maricopa AZ) was accepted on
 * Clever and never reached the QT email or the hand-off to Dave.
 *
 * The render-side loop is fixed separately. This closes the flow-side hole,
 * which is the more general one: the step had NO way to say "the actions
 * failed, but the page proves this step already worked, so carry on".
 *
 * Adds ONE field to the `accept` step:
 *
 *   continueWhenText: "you just accepted your"
 *
 * matched (case-insensitively) against the failure page. On a match the step is
 * recorded "skipped" and the run CONTINUES. That is the whole point, and the
 * difference from the `skipWhenText` the step already carries:
 *
 *   skipWhenText     "already been claimed"   -> another agent owns this lead,
 *                                               there is nothing to do, END the
 *                                               run. Left untouched.
 *   continueWhenText "you just accepted your" -> WE own it, the rest of the
 *                                               pipeline still has to run.
 *
 * Marker choice: the live heading is "You just accepted your 204th Clever
 * Referral". The ordinal changes per referral, so the marker stops before it.
 * It cannot appear on an unclaimed lead page (which shows an Accept button) or
 * on another agent's claim page (which is what the existing marker covers), so
 * the two guards cannot both fire on the same page.
 *
 * Side effect worth having: this also makes the step IDEMPOTENT. Today, re-running
 * the flow for a lead we already accepted fails at the first action, because
 * "Accept" only exists on an unclaimed page and "already been claimed" does not
 * match our own accept page. With this marker the step becomes a no-op there and
 * the flow can be safely replayed for a lead whose downstream was lost.
 *
 * PREREQUISITE: the ai-flow-worker must be on a build that understands
 * `continueWhenText`. Applying this before that ships is harmless (the field is
 * simply ignored) but buys nothing.
 *
 * Read-modify-write against the LIVE definition, so a hand edit made in the
 * dashboard since the last one-shot is preserved. Validated through the SAME
 * parseAiFlowDefinition the dashboard and CRUD API use. Dry-run by default;
 * idempotent (re-running after --apply reports nothing to do).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-accept-idempotent.ts            # dry run
 *   npx tsx scripts/oneshot/patch-clever-accept-idempotent.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_SEED_NAME (default "Clever Lead - Accept"),
 *           AIFLOW_CLEVER_ACCEPTED_MARKER (default "you just accepted your").
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
const bizFlag = process.argv.indexOf("--business-id");
const BUSINESS_ID =
  (bizFlag >= 0 ? process.argv[bizFlag + 1] : undefined) ??
  process.env.AIFLOW_SEED_BUSINESS_ID ??
  "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Accept";

/**
 * Ordinal-free fragment of Clever's post-accept confirmation heading. See the
 * header for why it stops before the ordinal and why it cannot collide with the
 * step's existing "already been claimed" marker.
 */
const ACCEPTED_MARKER =
  process.env.AIFLOW_CLEVER_ACCEPTED_MARKER ?? "you just accepted your";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** The accept step: the browse_action that clicks Accept and drives the wizard. */
function findAcceptStep(steps: FlowStep[]): number {
  return steps.findIndex(
    (s) =>
      s.type === "browse_action" &&
      (s.actions ?? []).some(
        (a) => a.kind === "click_text" && a.target.trim().toLowerCase() === "accept"
      )
  );
}

function patch(def: AiFlowDefinition): { next: AiFlowDefinition; changes: string[] } {
  const changes: string[] = [];
  const steps: FlowStep[] = [...def.steps];

  const idx = findAcceptStep(steps);
  if (idx < 0) {
    throw new Error(
      'no browse_action with a click_text "Accept" found, is this the Clever accept flow?'
    );
  }
  const step = steps[idx] as Extract<FlowStep, { type: "browse_action" }>;

  if (step.continueWhenText) {
    if (step.continueWhenText.trim().toLowerCase() === ACCEPTED_MARKER.toLowerCase()) {
      return { next: def, changes };
    }
    // Someone set a DIFFERENT marker. Do not silently overwrite a deliberate
    // choice: report it and let a human decide.
    throw new Error(
      `step "${step.id}" already has continueWhenText "${step.continueWhenText}" ` +
        `(wanted "${ACCEPTED_MARKER}"). Refusing to overwrite; set ` +
        "AIFLOW_CLEVER_ACCEPTED_MARKER to match, or edit the step deliberately."
    );
  }

  steps[idx] = { ...step, continueWhenText: ACCEPTED_MARKER };
  changes.push(`set continueWhenText "${ACCEPTED_MARKER}" on step ${idx} ("${step.id}")`);
  return { next: { ...def, steps }, changes };
}

async function main(): Promise<void> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) throw new Error(`read "${FLOW_NAME}": ${error.message}`);
  if (!data) throw new Error(`no "${FLOW_NAME}" flow for business ${BUSINESS_ID}`);
  const row = data as { id: string; name: string; enabled: boolean; definition: unknown };

  const current = parseAiFlowDefinition(row.definition);
  const { next, changes } = patch(current);
  if (changes.length === 0) {
    console.log(`"${FLOW_NAME}" already carries continueWhenText. Nothing to do.`);
    return;
  }

  let validated: AiFlowDefinition;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Patched definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(2);
    }
    throw err;
  }

  console.log(`Business : ${BUSINESS_ID}`);
  console.log(`Flow     : ${row.name} (id=${row.id}, enabled=${row.enabled})`);
  console.log(`Changes  : ${changes.join("; ")}`);
  console.log(`Summary  : ${summarizeDefinition(validated)}`);
  // Printed so a bad apply can be reverted without digging for a backup.
  console.log(`\nPrevious definition (for rollback):\n${JSON.stringify(row.definition)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }

  const { error: updErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (updErr) throw new Error(`update failed: ${updErr.message}`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-clever-accept-idempotent.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, flow_name: row.name, changes }
  });
  console.log(`\nPatched "${row.name}" (${changes.length} change(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
