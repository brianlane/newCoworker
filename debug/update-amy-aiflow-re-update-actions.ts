#!/usr/bin/env tsx
/**
 * One-shot: fix the `re_update` browse_action selectors in a tenant's
 * "ReferralExchange lead" AiFlow so the timeline-update sequence actually
 * completes.
 *
 * The ReferralExchange "Update Status" modal changed: the note field is a
 * `<textarea name="message">` (placeholder "This update is visible to you and
 * our support team"), NOT a placeholder of "Add an update", and the submit
 * button reads "Update", NOT "Submit". The old config timed out on action #4
 * (fill_placeholder "Add an update"), which the render service reported as
 * action_failed. New, DOM-verified sequence:
 *
 *   1. click_text     "Leave an update"               (opens the modal)
 *   2. click_text     "No interaction yet"            (status group)
 *   3. click_text     "I am still trying to contact"  (matches "...contact <name>")
 *   4. fill_selector  textarea[name="message"]        (the timeline note)
 *   5. click_selector .update-status-container .submit.action-details button  ("Update")
 *
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, and is idempotent.
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/update-amy-aiflow-re-update-actions.ts            # dry run
 *   tsx debug/update-amy-aiflow-re-update-actions.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_UPDATE_FLOW_NAME, AIFLOW_UPDATE_STEP_ID.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError,
  type FlowStep
} from "../src/lib/ai-flows/schema.ts";

const BUSINESS_ID = process.env.AIFLOW_UPDATE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const FLOW_NAME = process.env.AIFLOW_UPDATE_FLOW_NAME ?? "ReferralExchange lead";
const STEP_ID = process.env.AIFLOW_UPDATE_STEP_ID ?? "re_update";

const NEW_ACTIONS = [
  { kind: "click_text", target: "Leave an update" },
  { kind: "click_text", target: "No interaction yet" },
  { kind: "click_text", target: "I am still trying to contact" },
  {
    kind: "fill_selector",
    target: 'textarea[name="message"]',
    valueTemplate: "Update from Amy's AI assistant: {{vars.actions_taken}}. Will keep following up."
  },
  { kind: "click_selector", target: ".update-status-container .submit.action-details button" }
] as const;

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No flow "${FLOW_NAME}" for business ${BUSINESS_ID}`);
    process.exit(1);
  }

  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}\n`);

  const def = parseAiFlowDefinition(row.definition);
  const steps: FlowStep[] = def.steps.map((s) => ({ ...s }));

  const idx = steps.findIndex((s) => s.id === STEP_ID && s.type === "browse_action");
  if (idx === -1) {
    console.error(`No browse_action step "${STEP_ID}" found`);
    process.exit(1);
  }
  const step = steps[idx];
  if (step.type !== "browse_action") {
    console.error(`Step "${STEP_ID}" is not a browse_action`);
    process.exit(1);
  }

  const before = JSON.stringify(step.actions);
  steps[idx] = { ...step, actions: NEW_ACTIONS.map((a) => ({ ...a })) };
  const after = JSON.stringify(NEW_ACTIONS);

  const nextDefinition = { ...def, steps };
  let validated;
  try {
    validated = parseAiFlowDefinition(nextDefinition);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Updated definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Updated definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Flow    : ${row.id} (${row.name}, enabled=${row.enabled})`);
  console.log(`Summary : ${summarizeDefinition(validated)}`);
  console.log(`Step    : ${STEP_ID}`);
  console.log(`Actions before: ${before}`);
  console.log(`Actions after : ${after}`);
  if (before === after) {
    console.log("\n(no change — already applied)");
  }

  if (!apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("\nUpdated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
