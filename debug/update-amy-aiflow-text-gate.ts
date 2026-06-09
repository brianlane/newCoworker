#!/usr/bin/env tsx
/**
 * One-shot: gate the SMS-to-lead branch of a tenant's "ReferralExchange lead"
 * AiFlow on the lead page actually offering a TEXT contact option.
 *
 * Some ReferralExchange leads only show CALL and EMAIL buttons (no TEXT). For
 * those, the lead should not be texted at all — skip the approval_gate and
 * send_sms steps, but still send the owner email and route to the team.
 *
 * A `when` guard holds a single condition, so this works with a combined
 * extraction field instead of AND-ing two conditions:
 *
 *   1. `browse` gains a `sms_lead_type` field: the lead type (buyer/seller/
 *      both) when a TEXT option is shown, or exactly "none" when it isn't.
 *   2. Every approval_gate / send_sms step gated on `lead_type` is re-pointed
 *      at `sms_lead_type` (same equals value). No value ever equals "none",
 *      so flows for un-textable leads skip the whole SMS branch.
 *   3. Emails and route_to_team keep their `lead_type` gates untouched.
 *
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, and is idempotent.
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/update-amy-aiflow-text-gate.ts            # dry run
 *   tsx debug/update-amy-aiflow-text-gate.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_UPDATE_FLOW_NAME.
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

const SMS_LEAD_TYPE_FIELD = {
  name: "sms_lead_type",
  description:
    "If the page shows a TEXT contact option/button for this lead, answer with the lead type " +
    "as exactly one lowercase word: buyer, seller, or both. If there is NO TEXT option " +
    "(for example only CALL and EMAIL buttons), answer exactly: none"
};

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

  // 1. sms_lead_type extraction field on the browse step.
  const browseIdx = steps.findIndex((s) => s.type === "browse_extract");
  if (browseIdx === -1) {
    console.error("No browse_extract step found");
    process.exit(1);
  }
  const browse = steps[browseIdx];
  if (browse.type === "browse_extract" && !browse.fields.some((f) => f.name === SMS_LEAD_TYPE_FIELD.name)) {
    steps[browseIdx] = { ...browse, fields: [...browse.fields, SMS_LEAD_TYPE_FIELD] };
  }

  // 2. Re-point the SMS branch (approval gates + lead texts) at sms_lead_type.
  const retargeted: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (
      (s.type === "approval_gate" || s.type === "send_sms") &&
      s.when?.var === "lead_type" &&
      s.when.equals !== undefined
    ) {
      steps[i] = { ...s, when: { ...s.when, var: SMS_LEAD_TYPE_FIELD.name } };
      retargeted.push(s.id);
    }
  }

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

  console.log(`Flow      : ${row.id} (${row.name}, enabled=${row.enabled})`);
  console.log(`Summary   : ${summarizeDefinition(validated)}`);
  console.log(`Retargeted: ${retargeted.length ? retargeted.join(", ") : "(none — already applied)"}`);

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
